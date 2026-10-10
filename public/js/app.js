(function () {
  "use strict";

  const state = {
    datasetId: null,
    dataset: null,
    mode: "calc",
    page: "builder", // "builder" | "results"
    // NOTE: `cascade` here is the internal chain data model (root recipe tree +
    // target rate), NOT the old "Дерево (каскад)" UI tab (which was removed).
    // The tree solver strategy is still called "cascade" server-side; only the
    // tab that let you hand-edit the tree is gone. Chains are now started from
    // the "Поиск рецепта" tab.
    cascade: { root: null, targetRate: 1, targetRateUnit: "sec" },
    belt: { speed: 15 }, // output always assumed 2-sided (one item, both lanes)
    // Куда едет лента выгрузки в чертеже относительно лент подачи:
    //   "same"     — в ту же сторону, что подача (по умолчанию): и подача, и
    //                выгрузка подключаются с одного конца блока;
    //   "opposite" — в другую сторону (подача на север, выгрузка на юг).
    beltSides: "same",
    // РАЗДЕЛ «МАНИПУЛЯТОРЫ»: единственный источник правды о манипуляторах.
    // Ключ — имя прототипа, значение — { hand, speed } (сколько предметов за раз
    // и скорость оборота в об/тик). Пусто/нет ключа — берём из дампа. Дамп приносит
    // только то, что есть в прототипе и в сейве (встроенную пачку и, если экспортёр
    // v4, — пачку с исследованиями), а всё остальное человек вписывает тут.
    inserterSetup: {},
    // В каких единицах показывать/принимать скорость в таблице (хранение — всегда
    // об/тик). По умолчанию «°/сек» — именно это число показывает игра.
    inserterSpeedUnit: "deg",
    // По какому столбцу отсортирована таблица раздела «Манипуляторы».
    inserterSort: { key: "total", dir: "desc" },
    onlyUnlocked: false, // filter recipes by what's actually researched in the save
    // Настройки → «везде показывать только изученные рецепты». Это НЕ то же самое,
    // что галочка на «Поиске рецепта»: расчёт смотрит только сюда, а поиск —
    // на свою галочку (её можно снять и найти неизученное).
    settingsOnlyUnlocked: false,
    // Настройки → «убирать описания»: прячет длинные пояснения (абзацы, врезки,
    // подсказки у лент), оставляя цифры, кнопки и поля ввода.
    hideHints: false,
    inputPairs: {}, // { itemKey: pairedItemKey } - drag-to-share-a-belt for INPUT resources
    lastResult: null,
    chainId: null,
    dirty: false, // true once any calculation happened since the last save/load
    // Кабинет: кто вошёл и что сервер рассказал про вход (см. /api/auth/me).
    // null — ещё не спрашивали, {user: null} — кабинета нет.
    account: null,
  };

  // «Чистый выход»: report of the last settleChainNet() for the tab on screen -
  // what the chain makes, how much of it goes back into the chain, and what is
  // left over. Null when the chain does not recycle its own product.
  let netOutputReport = null;

  const LAST_DATASET_KEY = "chaincalc_last_dataset_id";
  // Настройка «везде показывать только изученные рецепты» — общая для страницы,
  // поэтому и ключ один, без имени датасета (в отличие от галочки поиска рецепта).
  const SETTINGS_UNLOCKED_KEY = "chaincalc_only_unlocked_everywhere";
  // «Убирать описания»: страница без длинных пояснений — только цифры, кнопки и
  // поля. Прячем классом на body (см. style.css), поэтому перерисовывать ничего
  // не нужно: работает и на уже нарисованных карточках.
  const SETTINGS_HIDE_HINTS_KEY = "chaincalc_hide_hints";
  // Настройка переживает перезагрузку страницы: она общая, а не по датасету.
  // localStorage бывает недоступен (приватный режим, тестовый импорт файла) —
  // тогда просто остаётся значение по умолчанию.
  try {
    state.settingsOnlyUnlocked = localStorage.getItem(SETTINGS_UNLOCKED_KEY) === "1";
  } catch (e) {
    state.settingsOnlyUnlocked = false;
  }
  try {
    state.hideHints = localStorage.getItem(SETTINGS_HIDE_HINTS_KEY) === "1";
  } catch (e) {
    state.hideHints = false;
  }

  // ---------- multi-tab chains ----------
  // Lets you click a raw input in one calculation and spin up a whole
  // separate sub-calculation for how to produce it, with its target rate
  // pre-filled from how much the first calculation actually consumes.
  // Only the ACTIVE tab's data lives in state.cascade/lastResult/inputPairs
  // (so all the existing rendering code keeps working unmodified) - other
  // tabs are parked in tabSnapshots and swapped in on activation.
  let calcTabs = [{ id: "t" + Math.random().toString(36).slice(2) }];
  let activeTabIndex = 0;
  const tabSnapshots = {};
  // Groups of tabs that all produce the SAME item via different recipes -
  // formed by dragging one tab onto another. { groupId: { itemKey, targetTotal } }
  const tabGroups = {};

  function saveCurrentTabSnapshot() {
    const tab = calcTabs[activeTabIndex];
    if (!tab) return;
    tabSnapshots[tab.id] = {
      cascade: state.cascade,
      lastResult: state.lastResult,
      inputPairs: state.inputPairs,
    };
  }

  function loadTabIntoState(index) {
    const tab = calcTabs[index];
    const snap = tabSnapshots[tab.id] || {
      cascade: { root: null, targetRate: 1, targetRateUnit: "sec" },
      lastResult: null,
      inputPairs: {},
    };
    state.cascade = snap.cascade;
    state.lastResult = snap.lastResult;
    state.inputPairs = snap.inputPairs;
  }

  function resetCalcTabs() {
    calcTabs = [{ id: "t" + Math.random().toString(36).slice(2) }];
    activeTabIndex = 0;
    for (const key of Object.keys(tabSnapshots)) delete tabSnapshots[key];
    for (const key of Object.keys(tabGroups)) delete tabGroups[key];
  }

  function switchToTab(index) {
    if (index === activeTabIndex) return;
    saveCurrentTabSnapshot();
    activeTabIndex = index;
    loadTabIntoState(index);
    // Сундук делали для другой вкладки — чужой не показываем.
    clearChainChest();
    renderCalcTabBar();
    renderResults();
    renderInputResources();
  }

  function closeTab(index) {
    if (index < 0 || index >= calcTabs.length) return;
    // Последнюю вкладку удалять нечем: расчёт должен где-то жить.
    if (calcTabs.length <= 1) return;
    const tab = calcTabs[index];
    const wasFirst = index === 0;
    const nameInput = document.getElementById("chainName");
    delete tabSnapshots[tab.id];
    calcTabs.splice(index, 1);
    // if this was the last member of a group, drop the now-empty group
    if (tab.groupId && !calcTabs.some((t) => t.groupId === tab.groupId)) {
      delete tabGroups[tab.groupId];
    }
    if (activeTabIndex === index) {
      // На месте удалённой встаёт соседняя: у первой вкладки это новая первая.
      activeTabIndex = Math.max(0, index - 1);
      loadTabIntoState(activeTabIndex);
      clearChainChest();
      renderResults();
      renderInputResources();
    } else if (activeTabIndex > index) {
      activeTabIndex -= 1;
    }
    // Удалили первую вкладку: вторая становится первой, то есть это уже другая цепочка
    // (другой конечный продукт). Поэтому:
    //   * загруженная запись отпускается — сохранение создаст новую;
    //   * имя в поле становится названием нового конечного продукта;
    //   * вкладки, выросшие из удалённой, спрашиваются и убираются, если они больше не
    //     участвуют в цепочке новой первой.
    if (wasFirst) {
      state.chainId = null;
      const newRootId = calcTabs[0] && calcTabs[0].id;
      const ask = "Хотите удалить вкладки, которые были привязаны к первой вкладке и больше не нужны?";
      if (newRootId && typeof confirm === "function" && confirm(ask)) {
        dropTabsOutsideChain(newRootId);
      }
      if (nameInput) nameInput.value = chainNameFromFirstTab();
    }
    renderCalcTabBar();
  }

  /** Имя цепочки по её первой вкладке: название конечного продукта.
   *
   *  Нужно после сдвига вкладок: корнем стала другая вкладка — значит цепочка
   *  теперь про другой продукт, так она и должна называться и сохраняться.
   */
  function chainNameFromFirstTab() {
    const firstTab = calcTabs[0];
    if (!firstTab || !state.dataset) return "";
    const cascade = firstTab.id === calcTabs[activeTabIndex]
      ? state.cascade
      : (tabSnapshots[firstTab.id] || {}).cascade;
    const key = cascade && cascade.root && cascade.root.primaryProduct;
    return key ? keyDisplayName(state.dataset, key) : "";
  }

  /** Удалить вкладки, которых нет в цепочке вкладки rootId (её саму не трогаем).
   *
   *  Цепочка — это сама вкладка плюс всё, что выросло из её ресурсов
   *  (parentInfo.tabId), на любую глубину — см. chainTabIds. Если активной была
   *  удалённая вкладка, встаём на новую первую.
   */
  function dropTabsOutsideChain(rootId) {
    const keep = new Set(chainTabIds(rootId));
    const activeId = calcTabs[activeTabIndex] && calcTabs[activeTabIndex].id;
    for (let index = calcTabs.length - 1; index >= 0; index--) {
      const tab = calcTabs[index];
      if (keep.has(tab.id)) continue;
      delete tabSnapshots[tab.id];
      if (tab.groupId && !calcTabs.some((t) => t.groupId === tab.groupId && t.id !== tab.id)) {
        delete tabGroups[tab.groupId];
      }
      calcTabs.splice(index, 1);
    }
    if (activeId && !calcTabs.some((t) => t.id === activeId)) {
      activeTabIndex = 0;
      loadTabIntoState(0);
      clearChainChest();
      renderResults();
      renderInputResources();
    }
  }

  async function addTabForResource(rootNode, targetRate, sourceItemKey) {
    const parentTabId = calcTabs[activeTabIndex].id;
    saveCurrentTabSnapshot();
    const id = "t" + Math.random().toString(36).slice(2);
    calcTabs.push({ id, parentInfo: sourceItemKey ? { tabId: parentTabId, itemKey: sourceItemKey } : null });
    tabSnapshots[id] = {
      cascade: { root: rootNode, targetRate, targetRateUnit: "sec" },
      lastResult: null,
      inputPairs: {},
    };
    activeTabIndex = calcTabs.length - 1;
    loadTabIntoState(activeTabIndex);
    await runSolve();
    renderCalcTabBar();
    renderResults();
    renderInputResources();
  }

  function getTabCascade(tabId) {
    return tabId === calcTabs[activeTabIndex].id ? state.cascade : (tabSnapshots[tabId] || {}).cascade;
  }

  // `cascade.targetRate` is ALWAYS items/second; `targetRateUnit` only says how
  // the number is shown in the "Целевая скорость" field (see renderResults and
  // the unit-change handler). The /60 this used to do made every grouped tab
  // whose unit was "шт/мин" read 60x too small - the group total, the member
  // list and the scale factor all inherited that.
  function getTabTargetRateInSec(tabId) {
    const cascade = getTabCascade(tabId);
    if (!cascade) return 0;
    return cascade.targetRate || 0;
  }

  function computeGroupTotal(groupId) {
    return calcTabs
      .filter((t) => t.groupId === groupId)
      .reduce((sum, t) => sum + getTabTargetRateInSec(t.id), 0);
  }

  // Dragging one tab onto another groups them - only makes sense if they
  // both aim at the same final item, since the point is splitting one
  // demand across several alternative recipes running in parallel.
  function getTabLastResult(tabId) {
    return tabId === calcTabs[activeTabIndex].id ? state.lastResult : (tabSnapshots[tabId] || {}).lastResult;
  }

  // "Сводка" - a birds-eye view across every open tab at once: what recipe,
  // how many machines, what raw materials each one needs - side by side, so
  // you can see the whole multi-tab build at a glance instead of clicking
  // through tabs one at a time.
  function openSummaryModal() {
    const overlay = document.createElement("div");
    overlay.className = "modalOverlay";

    const columnsHtml = calcTabs
      .map((tab) => {
        const cascade = getTabCascade(tab.id);
        const root = cascade && cascade.root;
        if (!root) {
          return `<div class="summaryCol"><div class="summaryColHead">пустая вкладка</div></div>`;
        }
        const headIcon = root.primaryProduct ? iconImg(keyIconUrl(state.dataset, root.primaryProduct), 26) : "";
        const headName = root.primaryProduct ? keyDisplayName(state.dataset, root.primaryProduct) : "?";
        const groupNote =
          tab.groupId && tabGroups[tab.groupId]
            ? `<span class="hint">часть группы «${keyDisplayName(state.dataset, tabGroups[tab.groupId].itemKey)}»</span>`
            : "";
        const result = getTabLastResult(tab.id);

        if (!result || result.error) {
          return `<div class="summaryCol${tab.groupId ? " groupedCol" : ""}">
            <div class="summaryColHead">${headIcon}<b>${headName}</b>${groupNote}</div>
            <p class="error">${result && result.error ? result.error : "Ещё не рассчитано (нажми «Рассчитать»/«Пересчитать» на этой вкладке)"}</p>
          </div>`;
        }

        const stagesHtml = Object.values(result.nodes)
          .map((n) => {
            const recipe = state.dataset.recipes[n.recipeName];
            const machine = (state.dataset.entities || {})[n.machineName];
            // Modules are part of "what to build", so they belong on the build
            // list too - otherwise you'd assemble the block and wonder why it
            // doesn't hit the numbers.
            const treeNode = findTreeNodeById(root, n.id);
            const mods = (treeNode && treeNode.modules) || [];
            const modsLine = mods.length
              ? `<div class="sumModules">🔧 ${mods
                  .map((m) => {
                    const def = moduleDef(m.name);
                    return `${def ? def.label : prettify(m.name)} ×${m.count}`;
                  })
                  .join(", ")} <span class="hint">на завод</span></div>`
              : "";
            return `<div class="summaryStageRow">
              <div class="sumStageHead">${iconImg(recipeIconUrl(recipe), 16)}${recipeDisplayName(recipe)} → ${iconImg(
              machineIconUrl(machine),
              14
            )}${machineDisplayName(machine)} × <b>${n.machinesCeil}</b></div>
              ${modsLine}
              ${feedSummaryHTML(n, root)}
              ${outputSummaryHTML(n)}
            </div>`;
          })
          .join("");

        // Rates, targets and raw-input tallies deliberately left out - this is a
        // build list, not a throughput report. Those numbers live on the cards.
        return `<div class="summaryCol${tab.groupId ? " groupedCol" : ""}">
          <div class="summaryColHead">${headIcon}<b>${headName}</b>${groupNote}</div>
          <div class="summaryStages">${stagesHtml}</div>
        </div>`;
      })
      .join("");

    overlay.innerHTML = `<div class="modalPanel summaryModalPanel">
      <div class="modalHeader">Сводка по всем вкладкам <button class="modalClose">✕</button></div>
      <p class="hint">Что строить: заводы, группы подачи, и какие ресурсы едут по одной ленте вместе, а какие отдельно.</p>
      <div class="summaryTable">${columnsHtml}</div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector(".modalClose").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
  }

  // If every member was spawned from the SAME parent tab for the SAME
  // resource (the usual case - "here are 2 alternative recipes for the
  // grade-4-copper this other tab needs"), each one independently starts
  // out sized to cover the FULL need on its own. Summing them at grouping
  // time would double-count that same need. Use the real downstream demand
  // instead; only fall back to a plain (non-summed) estimate otherwise.
  //
  // The max() fallback is only right for members that are still INDEPENDENT
  // (each sized to the full need). Once redistributeGroup has run, the members'
  // rates are SHARES of one total, and max() silently shrinks the group: tabs
  // split 4 + 7.5 for a total of 11.5 came back as a target of 7.5 on every
  // re-group, which is what made "un-group and group again then it counts
  // correctly" look like the group had been wrong before. Un-grouping therefore
  // leaves the total on the tabs, and we reuse it when their rates still add up
  // to it (i.e. nothing was edited in the meantime).
  function estimateGroupInitialTarget(groupId) {
    const members = calcTabs.filter((t) => t.groupId === groupId);
    const remembered = members.map((m) => m.lastGroupTotal);
    const sameRemembered =
      remembered.length > 0 &&
      remembered.every((v) => typeof v === "number" && v > 0 && Math.abs(v - remembered[0]) < 1e-9);
    if (sameRemembered) {
      const sumNow = members.reduce((s, m) => s + getTabTargetRateInSec(m.id), 0);
      if (Math.abs(sumNow - remembered[0]) < 1e-6 * Math.max(1, remembered[0])) return remembered[0];
    }

    const firstParent = members[0] && members[0].parentInfo;
    const sameParent =
      firstParent && members.every((m) => m.parentInfo && m.parentInfo.tabId === firstParent.tabId && m.parentInfo.itemKey === firstParent.itemKey);
    if (sameParent) {
      const parentResult = getTabLastResult(firstParent.tabId);
      const parentCascade = getTabCascade(firstParent.tabId);
      // Потребность = сырьё из рецептов ПЛЮС топливо печей: уголь, который идёт
      // в рецепт «Раскалённого кокса», тот же уголь, которым эта печь и топится.
      const needed = tabRawNeed(parentCascade, parentResult, firstParent.itemKey);
      if (needed != null && needed > 0) return needed;
    }
    return Math.max(...members.map((m) => getTabTargetRateInSec(m.id)));
  }

  function groupTabs(idA, idB) {
    if (idA === idB) return;
    const tabA = calcTabs.find((t) => t.id === idA);
    const tabB = calcTabs.find((t) => t.id === idB);
    if (!tabA || !tabB) return;
    const rootA = (getTabCascade(idA) || {}).root;
    const rootB = (getTabCascade(idB) || {}).root;
    if (!rootA || !rootB || rootA.primaryProduct !== rootB.primaryProduct) {
      alert("Можно объединять только вкладки с одинаковым конечным продуктом.");
      return;
    }
    const groupId = tabA.groupId || tabB.groupId || "g" + Math.random().toString(36).slice(2);
    const oldGroupOfB = tabB.groupId;
    for (const t of calcTabs) {
      if (t.id === idA || t.id === idB || (oldGroupOfB && t.groupId === oldGroupOfB)) {
        t.groupId = groupId;
      }
    }
    const initialTarget = estimateGroupInitialTarget(groupId);
    tabGroups[groupId] = { itemKey: rootA.primaryProduct, targetTotal: initialTarget };
    for (const t of calcTabs) if (t.groupId === groupId) delete t.lastGroupTotal; // the total is on the group now
    // the group's whole point is that combined they cover the real need
    // instead of each duplicating it - rescale members to actually match.
    redistributeGroup(groupId, initialTarget);
  }

  function ungroupTab(groupId) {
    const group = tabGroups[groupId];
    for (const t of calcTabs) {
      if (t.groupId === groupId) {
        delete t.groupId;
        // Leave behind what the group ACTUALLY ran at (achievedTotal), not the
        // wished-for target: when the group's floor is above the target those
        // differ, and re-grouping these tabs must reproduce the real total, not
        // the unreachable wish. See estimateGroupInitialTarget.
        const remembered = group && (group.achievedTotal || group.targetTotal);
        if (typeof remembered === "number" && remembered > 0) t.lastGroupTotal = remembered;
      }
    }
    delete tabGroups[groupId];
    renderCalcTabBar();
    renderGroupSummary();
  }

  // Probe ONE machine's worth of a member recipe. We solve the member as a
  // throwaway cascade at 1/sec of its primary product and read the root
  // node back: because productivity/speed bonuses are fixed ratios (they
  // don't depend on the target rate), dividing the node's per-second figures
  // by its machine count gives the exact PER-MACHINE rates - without
  // duplicating the solver's math in JS.
  //
  // Returns:
  //   machines     - fractional machines to hit 1/sec of the primary
  //   primaryRate  - primary-item output per machine per second
  //   net          - { itemKey: netPerMachinePerSec }  (products minus
  //                  ingredients of the ROOT recipe; >0 = this recipe emits
  //                  the item, e.g. a byproduct; <0 = it consumes it)
  // The `net` map is what lets the group solver notice that one member's
  // byproduct is exactly what another member eats.
  async function probeMemberProfile(root) {
    if (!root || !state.datasetId) return null;
    ensureAllNodeEffects(root); // group members must be probed with their modules on
    try {
      const response = await apiFetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetId: state.datasetId, mode: "cascade", root, targetRate: 1 }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.error || !data.nodes) return null;
      const node = data.nodes[root.id];
      if (!node || !node.machines) return null;
      const machines = node.machines;
      const products = node.products || {};
      const ingredients = node.ingredients || {};
      const net = {};
      for (const k of new Set([...Object.keys(products), ...Object.keys(ingredients)])) {
        net[k] = ((products[k] || 0) - (ingredients[k] || 0)) / machines;
      }
      const primaryKey = root.primaryProduct || Object.keys(products)[0] || null;
      const primaryRate = primaryKey != null && products[primaryKey] != null ? products[primaryKey] / machines : 1 / machines;
      return { machines, primaryKey, primaryRate, net };
    } catch (e) {
      return null;
    }
  }

  // Backwards-compatible thin wrapper: just the primary-item per-machine rate.
  async function probePerMachineRate(root) {
    const p = await probeMemberProfile(root);
    return p ? p.primaryRate : 0;
  }

  // Scan a group's member profiles for an INTERNAL dependency: an item
  // (other than the group's own product) that at least one member emits as a
  // byproduct AND at least one OTHER member consumes as an ingredient. This
  // is the "медь 4 сорта делает отходы, а из отходов тоже делают медь 4"
  // situation. Returns a list of { itemKey, producers:[{id,rate}],
  // consumers:[{id,rate}] } where rate is the per-machine amount.
  function detectGroupCoupling(profiles, primaryKey) {
    const stats = {};
    for (const p of profiles) {
      for (const [k, v] of Object.entries(p.net)) {
        if (k === primaryKey || Math.abs(v) < 1e-12) continue;
        const s = stats[k] || (stats[k] = { producers: [], consumers: [] });
        if (v > 0) s.producers.push({ id: p.id, rate: v });
        else s.consumers.push({ id: p.id, rate: -v });
      }
    }
    const couplings = [];
    for (const [itemKey, s] of Object.entries(stats)) {
      if (s.producers.length && s.consumers.length) couplings.push({ itemKey, ...s });
    }
    return couplings;
  }

  // A LOOP THROUGH THE PARENT: the tab that eats the group's item (e.g. a hydrocyclone
  // eating "хромит 3 сорт") spits out a byproduct ("отходы") that one of the group's
  // members turns back into the same item. The byproduct is not made by any member, so
  // detectGroupCoupling cannot see it - but its amount is fixed by the group's total
  // target: perUnit = byproduct made per unit of the group's item the parent eats.
  // Returns [{ item, perUnit, consumer: profile }].
  async function detectParentLoops(groupId, profiles) {
    const group = tabGroups[groupId];
    const memberIds = new Set(profiles.map((p) => p.id));
    const link = calcTabs
      .filter((t) => t.groupId === groupId)
      .map((t) => t.parentInfo)
      .find((pi) => pi && pi.itemKey === group.itemKey && !memberIds.has(pi.tabId));
    if (!link) return [];
    // Walk from the tab that eats the group's item towards the head of the chain: every tab
    // on the way has a fixed flow per unit of the group's item, and whatever byproduct any of
    // them makes (the hydrocyclone's rejects, a separator's leftovers further up) can come
    // back to a member.
    const made = {}; // item -> amount per 1 unit of the group's item
    const seen = new Set(memberIds);
    let tabId = link.tabId;
    let eatenKey = group.itemKey;
    let units = 1; // how much of eatenKey this tab must receive per 1 unit of the group's item
    for (let depth = 0; tabId && !seen.has(tabId) && depth < 12; depth++) {
      seen.add(tabId);
      const root = (getTabCascade(tabId) || {}).root;
      const pp = root ? await probeMemberProfile(root) : null;
      if (!pp) break;
      const eats = -(pp.net[eatenKey] || 0);
      if (!(eats > 1e-12)) break;
      const machines = units / eats;
      const tab = calcTabs.find((t) => t.id === tabId);
      const next = tab && tab.parentInfo && tab.parentInfo.tabId && tab.parentInfo.itemKey ? tab.parentInfo : null;
      for (const [item, perMachine] of Object.entries(pp.net)) {
        if (item === group.itemKey || item === eatenKey || (next && item === next.itemKey) || perMachine <= 1e-12) continue;
        made[item] = (made[item] || 0) + machines * perMachine;
      }
      if (!next) break;
      units = machines * (pp.net[next.itemKey] || 0); // what this tab hands on to the next one
      if (!(units > 1e-12)) break;
      eatenKey = next.itemKey;
      tabId = next.tabId;
    }
    const loops = [];
    for (const [item, perUnit] of Object.entries(made)) {
      const consumer = profiles.find((p) => (p.net[item] || 0) < -1e-12);
      if (consumer) loops.push({ item, perUnit, consumer });
    }
    return loops;
  }

  // Size a group with parent loops: every byproduct the parent returns goes to the member
  // that recycles it (whole machines, rounded UP so nothing is left unprocessed); the
  // remaining need is split among the other members. Returns { counts, links } or null
  // when no member is left for the remaining need.
  function sizeParentLoops(profiles, loops, targetF) {
    const counts = {};
    const links = [];
    let covered = 0;
    for (const lp of loops) {
      const c = lp.consumer;
      if (counts[c.id] != null) continue;
      const wantPerMachine = -c.net[lp.item];
      const madeSec = lp.perUnit * targetF;
      counts[c.id] = Math.max(1, Math.ceil(madeSec / wantPerMachine - 1e-9));
      covered += counts[c.id] * c.primaryRate;
      links.push({ item: lp.item, consumerId: c.id, madeSec, usedSec: Math.min(madeSec, counts[c.id] * wantPerMachine) });
    }
    const rest = profiles.filter((p) => counts[p.id] == null);
    if (!rest.length || !links.length) return null;
    const alloc = allocateIntegerMachines(
      rest.map((p) => ({ id: p.id, rate: p.primaryRate })),
      Math.max(0, targetF - covered)
    );
    for (const p of rest) counts[p.id] = Math.max(1, alloc[p.id] || 0);
    return { counts, links };
  }

  // Arrange coupled members into a single dependency CHAIN and return them in
  // order: [main, secondary1, secondary2, ...]. The main makes the group item
  // from a raw input; each secondary makes the same item from the byproduct of
  // the member before it. Returns null if the members aren't a clean single
  // chain (no dependency, branching, a cycle, or a stray extra member) - the
  // caller then falls back to the even independent split.
  //
  // Each returned entry is the member's profile plus `inItem`: the intermediate
  // it consumes from its predecessor (null for the main).
  function buildCoupledChain(profiles, couplings) {
    if (!couplings.length) return null; // no internal dependency at all
    const edges = []; // producer -> consumer, one per intermediate
    for (const c of couplings) {
      // Every link must be exactly one producer feeding exactly one consumer.
      if (c.producers.length !== 1 || c.consumers.length !== 1) return null;
      if (c.producers[0].id === c.consumers[0].id) return null;
      edges.push({ from: c.producers[0].id, to: c.consumers[0].id, item: c.itemKey });
    }
    const ids = profiles.map((p) => p.id);
    if (edges.length !== ids.length - 1) return null; // a simple path has n-1 links

    const indeg = {};
    const outTo = {};
    const inItem = {};
    for (const id of ids) indeg[id] = 0;
    for (const e of edges) {
      indeg[e.to] += 1;
      if (outTo[e.from] != null) return null; // a member feeds two others -> not a single chain
      outTo[e.from] = e.to;
      inItem[e.to] = e.item;
    }
    const heads = ids.filter((id) => indeg[id] === 0);
    if (heads.length !== 1) return null; // need exactly one main (consumes nobody's byproduct)

    const order = [];
    const seen = new Set();
    for (let cur = heads[0]; cur != null; cur = outTo[cur]) {
      if (seen.has(cur)) return null; // cycle guard
      seen.add(cur);
      order.push(cur);
    }
    if (order.length !== ids.length) return null; // must cover every member exactly once

    const byId = {};
    for (const p of profiles) byId[p.id] = p;
    return order.map((id) => ({ ...byId[id], inItem: inItem[id] || null }));
  }

  // Size a coupled chain the way the user described it. The MAIN sets the pace:
  // grow its machine count one at a time; at each step every secondary is given
  // as many WHOLE machines as the byproduct coming down the chain can fully feed
  //   nSecondary = floor(byproduct_from_predecessor / consumed_per_machine)
  // and we check the group's total output of the target item. We stop the moment
  // the group as a whole covers the target (or slightly overshoots on the last
  // whole machine). Finally we give every member EXCEPT the main one extra
  // machine (+1) - so the last bit of byproduct that wasn't enough for a full
  // machine still gets picked up instead of being thrown away.
  function sizeCoupledChain(chain, targetF) {
    const k = chain.length;
    const counts = {};
    for (const m of chain) counts[m.id] = 0;

    let guard = 0;
    for (let nMain = 1; guard++ < 2_000_000; nMain++) {
      counts[chain[0].id] = nMain;
      for (let i = 1; i < k; i++) {
        const item = chain[i].inItem;
        const wOut = chain[i - 1].net[item] || 0; // byproduct made per predecessor machine
        const cIn = -(chain[i].net[item] || 0); // intermediate consumed per this-member machine
        const avail = counts[chain[i - 1].id] * wOut;
        counts[chain[i].id] = cIn > 1e-12 ? Math.floor(avail / cIn + 1e-9) : 0;
      }
      let total = 0;
      for (let i = 0; i < k; i++) total += counts[chain[i].id] * chain[i].primaryRate;
      if (total >= targetF - 1e-9) break;
    }

    for (let i = 1; i < k; i++) counts[chain[i].id] += 1; // +1 to everyone except the main
    return counts;
  }

  // Whole-machine allocation across the recipes of a group.
  //
  // The result must, in priority order:
  //   0) give EVERY usable recipe at least one machine (a group exists so
  //      several recipes run side by side; letting one drop to 0 defeats it)
  //      and cover the target (total output >= target, never less);
  //   1) keep the BIGGEST single-recipe machine count as small as possible -
  //      this is what stops the "one recipe has 2 machines, another has 20"
  //      lopsidedness. The smallest achievable peak is ceil(target / sumRates)
  //      (even a perfectly even split can't push every recipe below that), so
  //      we cap every recipe at that peak;
  //   2) use the FEWEST machines in total for that peak - so we don't
  //      over-provision just to look balanced;
  //   3) waste as little as possible (least overproduction) as a final
  //      tie-break.
  //
  // For recipes with equal/similar per-machine output (the common case) this
  // yields a genuinely even split, e.g. 10/10/10 instead of the old 1/28/1.
  // When one recipe is far more machine-efficient than another the counts can
  // still differ - but only as much as is actually unavoidable to hit the
  // target, never gratuitously.
  function allocateIntegerMachines(rates, targetSec) {
    const machines = {};
    for (const r of rates) machines[r.id] = 0;
    const valid = rates.filter((r) => r.rate > 1e-12);
    if (!valid.length || targetSec <= 1e-9) return machines;

    if (valid.length === 1) {
      machines[valid[0].id] = Math.ceil(targetSec / valid[0].rate - 1e-9);
      return machines;
    }

    const sumRate = valid.reduce((sum, r) => sum + r.rate, 0);
    // (1) smallest possible peak: if every recipe ran `c` machines the output
    // would be c*sumRate, so no allocation can keep its maximum below this.
    const peak = Math.max(1, Math.ceil(targetSec / sumRate - 1e-9));

    // (2) minimum machines to reach the target without any recipe exceeding
    // `peak`: fill the fastest recipes first (each machine there kills the
    // most deficit), each capped at `peak`. Because all-at-`peak` already
    // covers the target, this always terminates having met it.
    const counts = {};
    for (const r of valid) counts[r.id] = 1;
    let deficit = targetSec - sumRate;
    const byRateDesc = valid.slice().sort((a, b) => b.rate - a.rate);
    for (const r of byRateDesc) {
      if (deficit <= 1e-9) break;
      const canAdd = peak - counts[r.id];
      if (canAdd <= 0) continue;
      const add = Math.min(canAdd, Math.ceil(deficit / r.rate - 1e-9));
      counts[r.id] += add;
      deficit -= add * r.rate;
    }

    // (3) trim overproduction without changing the peak or the total machine
    // count: repeatedly shift one machine from a faster recipe to a slower one
    // whenever that lowers output but still clears the target. Greedy on the
    // biggest safe reduction each pass; converges quickly (small groups).
    let output = valid.reduce((s, r) => s + r.rate * counts[r.id], 0);
    for (let guard = 0; guard < 10000; guard++) {
      let bestMove = null;
      for (const from of valid) {
        if (counts[from.id] <= 1) continue; // never starve a recipe below its baseline
        for (const to of valid) {
          if (to.id === from.id || counts[to.id] >= peak) continue;
          const delta = from.rate - to.rate; // output drops by this if we move one machine
          if (delta <= 1e-12) continue; // only moves that actually cut waste
          if (output - delta < targetSec - 1e-9) continue; // must not fall under target
          if (!bestMove || delta > bestMove.delta) bestMove = { from: from.id, to: to.id, delta };
        }
      }
      if (!bestMove) break;
      counts[bestMove.from] -= 1;
      counts[bestMove.to] += 1;
      output -= bestMove.delta;
    }

    for (const r of valid) machines[r.id] = counts[r.id];
    return machines;
  }

  // Figure out how much of the group's target each member recipe should
  // actually produce. Probes each recipe's true per-machine rate, then
  // allocates whole machines (see allocateIntegerMachines) so the group
  // rounds UP to the nearest combination of full machines across recipes
  // instead of committing everything to one recipe and over-provisioning
  // it. Returns { tabId: ratePerSecOfTheGroupItem } or null if it couldn't
  // be computed at all, so the caller can fall back to a proportional split.
  async function computeOptimalGroupSplit(groupId, newTargetSec) {
    const group = tabGroups[groupId];
    if (!group || !state.datasetId) return null;
    const members = calcTabs.filter((t) => t.groupId === groupId);
    const activeId = calcTabs[activeTabIndex].id;
    const roots = [];
    for (const m of members) {
      const cascade = m.id === activeId ? state.cascade : (tabSnapshots[m.id] || {}).cascade;
      const root = cascade && cascade.root;
      if (root) roots.push({ id: m.id, root });
    }
    if (roots.length < 2) return null; // nothing to balance between

    // Probe each member's FULL per-machine profile: not just how much of the
    // group product it makes, but its net production/consumption of every
    // OTHER item too. That net map is what lets us notice an internal
    // dependency - e.g. "медь 4 сорта" makes "отходы" that the other member
    // recycles back into "медь 4 сорта".
    const profiles = [];
    for (const r of roots) {
      const p = await probeMemberProfile(r.root);
      if (!p || !(p.primaryRate > 1e-12)) {
        profiles.length = 0;
        break;
      }
      profiles.push({ id: r.id, ...p });
    }

    // Probing failed for a member (e.g. network hiccup) - fall back to the
    // simple independent balance using just primary rates.
    if (profiles.length !== roots.length) {
      const rates = [];
      for (const r of roots) rates.push({ id: r.id, rate: await probePerMachineRate(r.root) });
      if (!rates.some((r) => r.rate > 1e-12)) return null;
      const alloc = allocateIntegerMachines(rates, newTargetSec);
      group.coupling = null;
      const out = {};
      for (const r of rates) out[r.id] = (alloc[r.id] || 0) * r.rate;
      return out;
    }

    const couplings = detectGroupCoupling(profiles, group.itemKey);
    let machineAlloc = null;
    group.coupling = null;
    group.parentLoop = null;

    // Try to line the members up as a single dependency chain: main -> recycler
    // of its byproduct -> recycler of THAT byproduct -> ...
    const chain = buildCoupledChain(profiles, couplings);

    if (chain) {
      // Main sets the pace; secondaries are sized by the byproduct flowing down
      // the chain, then each secondary gets +1 machine. (See sizeCoupledChain.)
      const counts = sizeCoupledChain(chain, newTargetSec);
      machineAlloc = {};
      for (const link of chain) machineAlloc[link.id] = counts[link.id] || 0;

      // Per-link byproduct bookkeeping for the summary: how much intermediate
      // the predecessor makes vs how much this member wants (the +1 can make a
      // member want slightly more than is produced -> it runs a touch under
      // capacity rather than burning the leftover).
      const links = [];
      for (let i = 1; i < chain.length; i++) {
        const item = chain[i].inItem;
        const madeSec = (counts[chain[i - 1].id] || 0) * (chain[i - 1].net[item] || 0);
        const wantSec = (counts[chain[i].id] || 0) * -(chain[i].net[item] || 0);
        links.push({
          item,
          producerId: chain[i - 1].id,
          consumerId: chain[i].id,
          madeSec,
          usedSec: Math.min(wantSec, madeSec),
          shortfallSec: Math.max(0, wantSec - madeSec),
          surplusSec: Math.max(0, madeSec - wantSec),
        });
      }
      group.coupling = { mainId: chain[0].id, order: chain.map((l) => l.id), links };
    } else {
      const sized = sizeParentLoops(profiles, await detectParentLoops(groupId, profiles), newTargetSec);
      if (sized) {
        machineAlloc = sized.counts;
        group.coupling = null;
        group.parentLoop = sized.links;
      } else {
        // No internal dependency (truly independent recipes) or a tangled shape
        // that isn't a single clean chain: split evenly by machine count.
        const rates = profiles.map((p) => ({ id: p.id, rate: p.primaryRate }));
        machineAlloc = allocateIntegerMachines(rates, newTargetSec);
      }
    }

    const result = {};
    for (const p of profiles) result[p.id] = (machineAlloc[p.id] || 0) * p.primaryRate;
    return result;
  }

  // Actually rescale + re-solve every member of the group. Prefers the
  // integer-machine-aware split (see above); falls back to a proportional
  // split (keeping the members' current relative ratio) only if that
  // couldn't run at all (e.g. network hiccup while probing rates).
  async function redistributeGroup(groupId, newTarget) {
    const members = calcTabs.filter((t) => t.groupId === groupId);
    if (!members.length) return;
    const optimalRatesSec = await computeOptimalGroupSplit(groupId, newTarget);
    const currentTotal = computeGroupTotal(groupId);
    const scaleFactor = currentTotal > 1e-9 ? newTarget / currentTotal : null;
    const activeId = calcTabs[activeTabIndex].id;
    const workingBackup = { cascade: state.cascade, lastResult: state.lastResult, inputPairs: state.inputPairs };

    try {
      for (const m of members) {
        const isActive = m.id === activeId;
        const snap = isActive ? workingBackup : tabSnapshots[m.id];
        if (!snap || !snap.cascade) continue;
        // Everything in here is items/second (see getTabTargetRateInSec): the
        // display unit is NOT part of the stored number, so converting to and
        // from it here would scale a "шт/мин" tab by 60 and send that to the
        // solver as items/sec.
        let newSec;
        if (optimalRatesSec && optimalRatesSec[m.id] != null) {
          newSec = optimalRatesSec[m.id];
        } else {
          const currentSec = snap.cascade.targetRate || 0;
          newSec = scaleFactor != null ? currentSec * scaleFactor : newTarget / members.length;
        }
        snap.cascade.targetRate = newSec;

        state.cascade = snap.cascade;
        state.lastResult = snap.lastResult;
        state.inputPairs = snap.inputPairs || {};
        await runSolve();
        state.inputPairs = {};
        const updatedSnap = { cascade: state.cascade, lastResult: state.lastResult, inputPairs: state.inputPairs };
        tabSnapshots[m.id] = updatedSnap; // always, so recalcDescendantTabs below sees fresh data
        if (isActive) {
          workingBackup.cascade = updatedSnap.cascade;
          workingBackup.lastResult = updatedSnap.lastResult;
          workingBackup.inputPairs = updatedSnap.inputPairs;
        }
        await recalcDescendantTabs(m.id);
      }
    } finally {
      state.cascade = workingBackup.cascade;
      state.lastResult = workingBackup.lastResult;
      state.inputPairs = workingBackup.inputPairs;
    }
    tabGroups[groupId].targetTotal = newTarget;
    tabGroups[groupId].optimized = !!optimalRatesSec;
    // What the members were actually sized to (sum of the assigned rates). Equal
    // to the target whenever the wish was reachable; higher when the group's floor
    // (one machine per recipe) already overshoots it - the panel says so.
    tabGroups[groupId].achievedTotal = optimalRatesSec
      ? Object.values(optimalRatesSec).reduce((s, v) => s + v, 0)
      : null;
    renderCalcTabBar();
    renderResults();
    renderInputResources();
  }

  function renderGroupSummary() {
    const container = document.getElementById("tabGroupSummary");
    if (!container) return;
    const activeTab = calcTabs[activeTabIndex];
    if (!activeTab || !activeTab.groupId || !tabGroups[activeTab.groupId]) {
      container.innerHTML = "";
      return;
    }
    const groupId = activeTab.groupId;
    const group = tabGroups[groupId];
    const total = computeGroupTotal(groupId);
    const target = group.targetTotal || 0;
    const pct = target > 0 ? Math.min(100, (total / target) * 100) : 0;
    const members = calcTabs.filter((t) => t.groupId === groupId);
    const optimized = group.optimized !== false; // undefined (freshly grouped, before first redistribute) counts as "will be"
    const coupling = group.coupling || null;

    const memberRecipes = uniqueRecipes(members.map((m) => getTabCascade(m.id)));
    const memberName = (id) => {
      const cascade = getTabCascade(id);
      const recipe = cascade && cascade.root && state.dataset.recipes[cascade.root.recipeName];
      return recipe ? disambiguatedLabel(recipe, memberRecipes) : recipeDisplayName(recipe);
    };

    // Two modes. Independent recipes get an even split. A dependency chain
    // (main makes the item + a byproduct; each next member remakes the item
    // from the previous one's byproduct) is driven by the main: its machine
    // count grows until the group covers the target, secondaries are sized by
    // the byproduct available to them, and every secondary then gets +1 machine
    // to mop up the last bit of byproduct.
    const explainer = coupling
      ? `Эти рецепты выстроены в <b>цепочку зависимости</b>: главный (${memberName(coupling.mainId)}) делает
          «${keyDisplayName(state.dataset, group.itemKey)}» и попутно побочку, а каждый следующий участник делает тот же
          предмет уже из побочки предыдущего. <b>Темп задаёт главный</b>: его число заводов растёт, пока группа в сумме
          не покроет цель; заводы остальных считаются по тому, сколько побочки до них доходит. В конце каждому, кроме
          главного, добавляется +1 завод — чтобы подобрать остаток побочки, а не сжигать его (такой завод может
          работать не на полную).`
      : `Эти вкладки вместе производят один и тот же предмет разными <b>независимыми</b> рецептами. Система раскладывает
          нагрузку по заводам максимально ровно: сначала минимизирует самое большое число заводов у одного рецепта
          (чтобы не было «у одного 2 завода, у другого 20»), затем берёт наименьшую общую сумму заводов, и лишь в конце
          срезает перепроизводство. При близких по скорости рецептах это даёт равный делёж (например 10/10/10, а не 1/28/1).`;

    let couplingLine = "";
    if (coupling) {
      const orderNames = coupling.order.map(memberName).join(" → ");
      const linkLines = (coupling.links || [])
        .map((lk) => {
          const itemName = keyDisplayName(state.dataset, lk.item);
          let note = "";
          if (lk.shortfallSec > 1e-6) note = ` · не хватает ${lk.shortfallSec.toFixed(2)}/сек (переработчик чуть простаивает)`;
          else if (lk.surplusSec > 1e-6) note = ` · излишек ${lk.surplusSec.toFixed(2)}/сек`;
          else note = " · ровно";
          return `<div class="summaryLine"><span>Побочка «${itemName}»</span><span>${lk.madeSec.toFixed(
            2
          )}/сек делается → ${lk.usedSec.toFixed(2)}/сек в дело${note}</span></div>`;
        })
        .join("");
      couplingLine = `<div class="summaryLine"><span>Порядок цепочки</span><span>${orderNames}</span></div>${linkLines}`;
    }

    if (group.parentLoop && group.parentLoop.length) {
      couplingLine = group.parentLoop
        .map((lk) => {
          const note = lk.usedSec < lk.madeSec - 1e-6 ? ` · излишек ${(lk.madeSec - lk.usedSec).toFixed(2)}/сек` : " · всё в дело";
          return `<div class="summaryLine"><span>Возврат «${keyDisplayName(state.dataset, lk.item)}» из потребителя</span><span>${lk.madeSec.toFixed(
            2
          )}/сек → ${memberName(lk.consumerId)}${note}</span></div>`;
        })
        .join("");
    }

    // A group always runs at least ONE machine per member recipe, so it has a
    // floor: with recipes that each make several items per second, that floor can
    // sit far above the wished-for total (two recipes at 4 and 7.5/sec cannot
    // make less than 11.5/sec). Then "Суммарно сейчас 11.50 / 1.00 · профицит
    // 10.50" reads like a broken calculation, so say plainly that the goal is
    // below what the group can physically do. `achievedTotal` is what the last
    // redistribute actually managed.
    const achieved = typeof group.achievedTotal === "number" ? group.achievedTotal : total;
    const floorNote =
      target > 0 && achieved > target * 1.02
        ? `<div class="beltGroupNote warn">⚠ Точно в ${target.toFixed(2)}/сек не попасть: в группе минимум по одному
             заводу на каждый рецепт, а это уже <b>${achieved.toFixed(2)}/сек</b> — цель перекрыта на
             ${(achieved - target).toFixed(2)}/сек. Не хватать не будет; если профицит не нужен, убери лишний рецепт
             из группы или подними цель — тогда делёж сойдётся.</div>`
        : "";

    container.innerHTML = `
      <section class="panel groupSummaryPanel">
        <h2>Группа рецептов: ${keyDisplayName(state.dataset, group.itemKey)}</h2>
        <p class="hint">${explainer} Итог может быть чуть больше цели (округление до целых заводов), но никогда меньше. ${
          optimized ? "" : `<span class="inputResWarn">⚠ не удалось посчитать — сейчас пропорция сохраняется как была.</span>`
        }</p>
        <div class="recalcRow">
          <label class="hint">Нужно всего (шт/сек):</label>
          <input id="groupTargetInput" type="number" step="0.1" value="${target}" class="input recalcRateInput" />
        </div>
        <div class="summaryLine"><span>Суммарно сейчас</span><span>${total.toFixed(2)} / ${target.toFixed(2)} шт/сек</span></div>
        <div>${beltFillBarHTML(pct)}${
          total < target - 1e-6 ? ` не хватает ${(target - total).toFixed(2)}/сек` : total > target + 1e-6 ? ` профицит ${(total - target).toFixed(2)}/сек` : ""
        }</div>
        ${floorNote}
        ${couplingLine}
        <div class="groupMembers">
          ${members
            .map((m) => {
              const cascade = getTabCascade(m.id);
              const recipe = cascade && cascade.root && state.dataset.recipes[cascade.root.recipeName];
              const rate = getTabTargetRateInSec(m.id);
              return `<div class="groupMemberRow${m.id === activeTab.id ? " active" : ""}">${iconImg(recipeIconUrl(recipe), 18)}${recipe ? disambiguatedLabel(recipe, memberRecipes) : recipeDisplayName(recipe)}: ${rate.toFixed(2)} шт/сек</div>`;
            })
            .join("")}
        </div>
        <button id="ungroupBtn" class="btn btn-ghost small">Разгруппировать</button>
      </section>
    `;
    document.getElementById("groupTargetInput").addEventListener("change", (e) => {
      const newTarget = parseFloat(e.target.value) || 0;
      safeCall(() => redistributeGroup(groupId, newTarget));
    });
    document.getElementById("ungroupBtn").addEventListener("click", () => safeCall(() => ungroupTab(groupId)));
  }

  function renderCalcTabBar() {
    const bar = document.getElementById("calcTabBar");
    if (!bar) return;
    if (calcTabs.length <= 1) {
      bar.innerHTML = "";
      renderGroupSummary();
      return;
    }
    bar.innerHTML = "";
    calcTabs.forEach((tab, idx) => {
      const cascade = idx === activeTabIndex ? state.cascade : (tabSnapshots[tab.id] || {}).cascade;
      const root = cascade && cascade.root;
      const icon = root && root.primaryProduct ? iconImg(keyIconUrl(state.dataset, root.primaryProduct), 22) : "⛭";
      const title = root ? recipeDisplayName(state.dataset.recipes[root.recipeName]) : "";
      const div = document.createElement("div");
      div.className = "calcTab" + (idx === activeTabIndex ? " active" : "") + (tab.groupId ? " grouped" : "");
      const sameTitle = root ? uniqueRecipes(calcTabs.map((t2) => getTabCascade(t2.id))) : [];
      const fullTitle = root && state.dataset.recipes[root.recipeName]
        ? disambiguatedLabel(state.dataset.recipes[root.recipeName], sameTitle)
        : title;
      div.title = fullTitle + (tab.groupId ? " (в группе)" : "");
      div.draggable = true;
      div.innerHTML = `${icon}<span class="calcTabClose">✕</span>`;
      div.addEventListener("click", (e) => {
        if (e.target.closest(".calcTabClose")) {
          safeCall(() => closeTab(idx));
          return;
        }
        safeCall(() => switchToTab(idx));
      });
      div.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", tab.id));
      div.addEventListener("dragover", (e) => {
        e.preventDefault();
        div.classList.add("dragOver");
      });
      div.addEventListener("dragleave", () => div.classList.remove("dragOver"));
      div.addEventListener("drop", (e) => {
        e.preventDefault();
        div.classList.remove("dragOver");
        const draggedId = e.dataTransfer.getData("text/plain");
        if (draggedId) safeCall(() => groupTabs(draggedId, tab.id));
      });
      bar.appendChild(div);
    });
    renderGroupSummary();
  }

  // Body of the "no producer at all" modal - built separately so the wording can be
  // tested without a DOM, and so the ignored-recipe note lives in one place.
  function recipePickerEmptyHTML(itemKeyToProduce) {
    const name = keyDisplayName(state.dataset, itemKeyToProduce);
    // "Nothing makes this" is only half the truth when the junk filter is what
    // removed the producer: for 474 items/fluids in a Pyanodon dump the ONLY
    // producer is an unbarreling recipe (fluid:milk <- empty-milk-barrel), and the
    // panel used to insist there is no recipe at all. Say what we ignored.
    const ignored = ignoredProducers(state.dataset, itemKeyToProduce);
    const ignoredNote = ignored.length
      ? `<p class="hint">Но кое-что есть среди рецептов, которые калькулятор не считает производством
           (раскупоривание бочек, «void»-уничтожение, сжигание): ${ignored
             .slice(0, 4)
             .map((r) => recipeDisplayName(r))
             .join(", ")}${ignored.length > 4 ? ` и ещё ${ignored.length - 4}` : ""}.
           Для расчёта такой источник не годится — он не делает предмет, а переносит его из бочки.</p>`
      : "";
    return `<div class="modalPanel">
        <div class="modalHeader">Как получить «${name}»? <button class="modalClose">✕</button></div>
        <p class="error">В этом датасете нет ни одного рецепта, который производит этот предмет.</p>
        ${ignoredNote}
      </div>`;
  }

  // Modal for picking how to produce a given raw input - reuses the same
  // "list every recipe that makes this item" idea as the recipe search tab, but
  // as a popup, and wires the choice straight into a new calculation tab.
  function openRecipePickerModal(itemKeyToProduce, targetRate) {
    const candidates = findRecipesProducing(state.dataset, itemKeyToProduce);
    const overlay = document.createElement("div");
    overlay.className = "modalOverlay";
    const name = keyDisplayName(state.dataset, itemKeyToProduce);
    if (!candidates.length) {
      overlay.innerHTML = recipePickerEmptyHTML(itemKeyToProduce);
    } else {
      overlay.innerHTML = `<div class="modalPanel">
        <div class="modalHeader">Как получить «${name}» (${targetRate.toFixed(2)}/сек)? <button class="modalClose">✕</button></div>
        ${
          candidates.length > 1
            ? `<button id="pickAllAndGroupBtn" class="btn btn-ghost small" style="margin-bottom:10px;">Выбрать все ${candidates.length} и объединить в группу</button>`
            : ""
        }
        <div class="modalBody">
          ${candidates
            .map(
              (r, idx) =>
                `<div class="pathOption" data-recipe="${r.name}"><div class="routeLabel">Способ ${idx + 1}</div><div class="pathOptionMain"><div class="recipeTitleBlock"><div class="routeSteps"><span class="step">${iconImg(
                  recipeIconUrl(r),
                  22
                )}${disambiguatedLabel(r, candidates)}</span></div>${recipeMachineHTML(r)}</div>${recipeIOHTML(r, itemKeyToProduce)}</div></div>`
            )
            .join("")}
        </div>
      </div>`;
    }
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector(".modalClose").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelectorAll(".pathOption").forEach((el) => {
      el.addEventListener("click", () => {
        const recipe = state.dataset.recipes[el.dataset.recipe];
        const newNode = makeDefaultNode(recipe, itemKeyToProduce);
        close();
        safeCall(() => addTabForResource(newNode, targetRate, itemKeyToProduce));
      });
    });
    const groupBtn = overlay.querySelector("#pickAllAndGroupBtn");
    if (groupBtn) {
      groupBtn.addEventListener("click", () => {
        close();
        safeCall(() => addAllCandidatesAsGroup(itemKeyToProduce, targetRate, candidates.map((r) => r.name)));
      });
    }
  }

  // "Выбрать все и объединить": spins up one tab per alternative recipe for
  // this item, then groups them all together so their combined output
  // covers the real need instead of each one duplicating it.
  async function addAllCandidatesAsGroup(itemKeyToProduce, targetRate, recipeNames) {
    const newTabIds = [];
    for (const recipeName of recipeNames) {
      const recipe = state.dataset.recipes[recipeName];
      if (!recipe) continue;
      const newNode = makeDefaultNode(recipe, itemKeyToProduce);
      await addTabForResource(newNode, targetRate, itemKeyToProduce);
      newTabIds.push(calcTabs[activeTabIndex].id);
    }
    for (let i = 1; i < newTabIds.length; i++) {
      groupTabs(newTabIds[0], newTabIds[i]);
    }
  }



  let uidCounter = 1;
  const uid = () => "n" + uidCounter++;

  // ---------- display names ----------
  // Prefer the real localised name from the dump (display_name, resolved by
  // the export-mod in your game's language, e.g. Russian). Fall back to a
  // prettified internal key if it's missing (untranslated mod, or the small
  // sample dataset that ships without translations).

  // UI language helpers (public/js/i18n.js; absent in the node test harness).
  function uiLocale() {
    return window.i18n ? window.i18n.locale() : "ru-RU";
  }
  function i18nText(text) {
    return window.i18n ? window.i18n.t(text) : text;
  }

  function prettify(name) {
    if (!name) return "";
    return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function recipeDisplayName(recipe) {
    return (recipe && (recipe.display_name || prettify(recipe.name))) || "?";
  }

  // Pyanodon (and modpacks in general) often have several *different*
  // recipes whose localised name is identical (e.g. chopping different tree
  // species all just show up as "Бревно"). Disambiguate those with the
  // internal recipe id + category so they're actually distinguishable in a
  // dropdown.
  function disambiguatedLabel(recipe, siblings) {
    const label = recipeDisplayName(recipe);
    const same = siblings.filter((s) => recipeDisplayName(s) === label);
    if (same.length < 2) return label;
    // Сначала различаем по-русски: «Хромит (3 сорт) — из: Хромитовые отходы». Внутренний id
    // добавляется только если и состав входа у рецептов одинаковый.
    const from = recipeFromText(recipe);
    if (from) {
      const sameFrom = same.filter((s) => recipeFromText(s) === from);
      if (sameFrom.length < 2) return `${label} — из: ${from}`;
    }
    return `${label} — ${recipe.name} (${recipe.category || "?"})`;
  }

  // Рецепты корней этих каскадов, без повторов по имени (одна и та же вкладка дважды — не «одноимённые»).
  function uniqueRecipes(cascades) {
    const byName = new Map();
    for (const c of cascades) {
      const r = c && c.root && state.dataset.recipes[c.root.recipeName];
      if (r && !byName.has(r.name)) byName.set(r.name, r);
    }
    return [...byName.values()];
  }

  // «Хромитовые отходы, Вода» — названия входов рецепта (по-русски, как в датасете).
  function recipeFromText(recipe) {
    return asArray(recipe && recipe.ingredients)
      .map((ing) => keyDisplayName(state.dataset, `${ing.type || "item"}:${ing.name}`))
      .join(", ");
  }

  // Right-hand "what this recipe needs" strip: every ingredient (both belt
  // items and piped fluids/gases) with its icon and amount per one craft.
  function recipeNeedsHTML(recipe) {
    const ings = asArray(recipe && recipe.ingredients);
    if (!ings.length) return `<span class="recipeNeeds"><span class="recipeNeedsEmpty">без сырья</span></span>`;
    const parts = ings.map((ing) => recipeStackHTML(ing));
    return `<span class="recipeNeeds"><span class="recipeNeedsLabel">нужно на 1 крафт:</span>${parts.join("")}</span>`;
  }

  // "получим" strip: how much of the product this recipe yields per one craft.
  // If `targetKey` is given, only that product is shown (the item we're trying
  // to make); otherwise every product of the recipe is listed.
  function recipeYieldHTML(recipe, targetKey) {
    let products = asArray(recipe && recipe.products);
    if (!products.length) return "";
    if (targetKey) {
      const [ttype, tname] = targetKey.split(/:(.+)/);
      const match = products.filter((p) => (p.type || "item") === ttype && p.name === tname);
      if (match.length) products = match;
    }
    const parts = products.map((p) => recipeStackHTML(p));
    return `<span class="recipeNeeds recipeYields"><span class="recipeNeedsLabel">получим:</span>${parts.join("")}</span>`;
  }

  // One icon + amount chip for an ingredient or product (handles fixed amounts,
  // min–max ranges, a probability under 100%, and the temperature a fluid carries:
  // "= 250°", ">= 950°"). The temperature is what the picker already filters
  // candidates by, so showing it explains why only some recipes are offered.
  function recipeStackHTML(stack) {
    const type = stack.type || "item";
    const url = itemIconUrl(state.dataset, type, stack.name);
    const nm = itemDisplayName(state.dataset, type, stack.name);
    let amt;
    if (stack.amount != null) amt = +Number(stack.amount).toFixed(3);
    else if (stack.amount_min != null && stack.amount_max != null) amt = `${stack.amount_min}–${stack.amount_max}`;
    else amt = "?";
    const prob = stack.probability != null && stack.probability < 1 ? `<span class="needProb">${+(stack.probability * 100).toFixed(1)}%</span>` : "";
    const temp = type === "fluid" ? fluidTempLabel(specKey(stack)) : "";
    const tempHtml = temp ? `<span class="needTemp" title="температура">${temp}</span>` : "";
    const pipe = type === "fluid" ? `<span class="viaPipe" title="по трубе">труба</span>` : "";
    return `<span class="recipeNeed" title="${nm}${type === "fluid" ? " (по трубе)" : ""}">${iconImg(url, 16)}<span class="needAmt">×${amt}</span>${tempHtml}${prob}${pipe}</span>`;
  }

  // Stacked "получим / нужно" block shown on the right of each recipe option.
  function recipeIOHTML(recipe, targetKey) {
    return `<div class="recipeIO">${recipeYieldHTML(recipe, targetKey)}${recipeNeedsHTML(recipe)}</div>`;
  }

  // «[иконка] Название завода» — самый простой завод под категорию рецепта (его же ставит расчёт),
  // и сколько ещё подходит.
  function recipeMachineHTML(recipe) {
    const machines = state.dataset && recipe ? compatibleMachines(state.dataset, recipe) : [];
    if (!machines.length) return "";
    const first = machines[0];
    const more = machines.length > 1 ? ` <span class="recipeMachineMore">и ещё ${machines.length - 1}</span>` : "";
    return `<span class="recipeNeeds recipeMachine"><span class="recipeNeed">${iconImg(
      machineIconUrl(first),
      18
    )}<span>${escapeHtmlText(machineDisplayName(first))}</span></span>${more}</span>`;
  }

  function machineDisplayName(machine) {
    return (machine && (machine.display_name || prettify(machine.name))) || "?";
  }

  function machineIconUrl(machine) {
    return machine && machine.icon_url;
  }

  function itemDisplayName(dataset, type, name) {
    const table = type === "fluid" ? dataset.fluids : dataset.items;
    const entry = table && table[name];
    return (entry && (entry.display_name || prettify(name))) || prettify(name);
  }

  // icon_url is filled in by tools/extract_icons.py (run once locally) - the
  // raw dump from the mod only has an internal engine path, not a usable
  // image. Datasets without icons extracted yet just won't have this field,
  // and everything below degrades gracefully to plain text.
  function recipeIconUrl(recipe) {
    return recipe && recipe.icon_url;
  }

  function itemIconUrl(dataset, type, name) {
    const table = type === "fluid" ? dataset.fluids : dataset.items;
    const entry = table && table[name];
    return entry && entry.icon_url;
  }

  function iconImg(url, size) {
    if (!url) return "";
    return `<img src="${url}" class="icon" style="width:${size || 20}px;height:${size || 20}px" onerror="this.remove()" />`;
  }

  function itemKey(type, name) {
    return `${type}:${name}`;
  }

  // --- fluid temperatures (must mirror solver.py exactly, or UI keys and
  // backend keys diverge and children stop matching their producers) ---
  //
  // steam@165 and steam@500 are the same fluid but not interchangeable: a
  // turbine wants steam >= 500. So a fluid key carries its temperature:
  //   fluid:steam@500       exact
  //   fluid:steam@500:2000  a band (ingredient accepts 500..2000)
  //   fluid:water           no constraint
  function fmtTemp(t) {
    return Number.isInteger(t) ? String(t) : String(t);
  }

  // The dump writes ±FLT_MAX (≈3.4028e38) where the GAME means "no limit":
  // Pyanodon's fluids carry maximum_temperature = FLT_MAX when any temperature is
  // accepted. Taken literally, hot molten salt (>= 950) became the key
  // `fluid:hot-molten-salt@950:3.4028234663852894e+38` and the card read
  // "Горячая расплавленная соль 950–3.4028234663852894e+38°".
  // Normalising it to an open end here and in solver.fluid_temp_range keeps the
  // labels readable and makes both runtimes build the SAME key string (before,
  // JS wrote the short form and Python the long integer form, and only a numeric
  // fallback in _match_child hid the divergence).
  const TEMP_UNBOUNDED = 1e38;

  function saneTemp(v) {
    if (typeof v !== "number") return v;
    if (v >= TEMP_UNBOUNDED) return Infinity;
    if (v <= -TEMP_UNBOUNDED) return -Infinity;
    return v;
  }

  function fluidTempRange(spec) {
    if (typeof spec.temperature === "number") {
      const t = saneTemp(spec.temperature);
      return [t, t];
    }
    const lo = typeof spec.minimum_temperature === "number" ? saneTemp(spec.minimum_temperature) : null;
    const hi = typeof spec.maximum_temperature === "number" ? saneTemp(spec.maximum_temperature) : null;
    if (lo === null && hi === null) return null;
    return [lo === null ? -Infinity : lo, hi === null ? Infinity : hi];
  }

  function fluidKey(name, spec) {
    const rng = fluidTempRange(spec);
    if (!rng) return `fluid:${name}`;
    const [low, high] = rng;
    if (low === high) return `fluid:${name}@${fmtTemp(low)}`;
    const lo = low === -Infinity ? "" : fmtTemp(low);
    const hi = high === Infinity ? "" : fmtTemp(high);
    return `fluid:${name}@${lo}:${hi}`;
  }

  // Key for any ingredient/product, temperature-aware for fluids.
  function specKey(spec) {
    const type = spec.type || "item";
    if (type === "fluid") return fluidKey(spec.name, spec);
    return itemKey(type, spec.name);
  }

  // ('steam', low, high) for a fluid key, else null.
  function parseFluidKey(key) {
    if (!key.startsWith("fluid:")) return null;
    const body = key.slice("fluid:".length);
    const at = body.indexOf("@");
    if (at === -1) return [body, -Infinity, Infinity];
    const name = body.slice(0, at);
    const temp = body.slice(at + 1);
    if (temp.includes(":")) {
      const [lo, hi] = temp.split(":");
      return [name, lo ? parseFloat(lo) : -Infinity, hi ? parseFloat(hi) : Infinity];
    }
    const v = parseFloat(temp);
    return [name, v, v];
  }

  function fluidOutputSatisfies(outputKey, demandKey) {
    const out = parseFluidKey(outputKey);
    const dem = parseFluidKey(demandKey);
    if (!out || !dem) return outputKey === demandKey;
    if (out[0] !== dem[0]) return false;
    return out[1] >= dem[1] && out[2] <= dem[2];
  }

  // Human label for a fluid temperature part of a key: "500°" or "≥500°" or "165–500°".
  // The values are passed through saneTemp as well, so a key saved BEFORE the
  // sentinel was normalised (fluid:x@950:3.4028234663852894e+38, still sitting in
  // data/chains.json) reads "≥950°" instead of a 39-digit temperature.
  function fluidTempLabel(key) {
    const parsed = parseFluidKey(key);
    if (!parsed) return "";
    const low = saneTemp(parsed[1]);
    const high = saneTemp(parsed[2]);
    if (low === -Infinity && high === Infinity) return "";
    if (low === high) return `${fmtTemp(low)}°`;
    if (low === -Infinity) return `≤${fmtTemp(high)}°`;
    if (high === Infinity) return `≥${fmtTemp(low)}°`;
    return `${fmtTemp(low)}–${fmtTemp(high)}°`;
  }

  // Lua can't tell an empty array apart from an empty object, so the
  // export-mod's JSON sometimes sends {} where we expect [] (e.g. a mining
  // recipe with zero ingredients, or a machine with no crafting_categories
  // for some reason). Normalize every "should be a list" field through this.
  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.values(value);
    return [];
  }

  // A fluid key may carry a temperature (fluid:steam@500) - strip it before
  // looking the fluid up by name, but keep it for the label so the user sees
  // "Пар 500°" and can tell hot steam from cold.
  function keyBaseParts(key) {
    const parsed = parseFluidKey(key);
    if (parsed) return ["fluid", parsed[0]];
    const [type, name] = key.split(/:(.+)/);
    return [type, name];
  }

  function keyDisplayName(dataset, key) {
    const [type, name] = keyBaseParts(key);
    const base = itemDisplayName(dataset, type, name);
    const temp = fluidTempLabel(key);
    return temp ? `${base} ${temp}` : base;
  }

  function keyIconUrl(dataset, key) {
    const [type, name] = keyBaseParts(key);
    return itemIconUrl(dataset, type, name);
  }

  // Junk-recipe filter. dump_version >= 2 lets us do this on facts instead of
  // guessing from names:
  //   parameter    - 2.0 UI placeholder prototypes, not real recipes at all
  //   hidden       - the game itself hides them from the player
  //   is_recycling - Space Age auto-generates "recycle X" for nearly EVERY item;
  //                  left in, they flood the recipe graph with thousands of edges
  //                  and the producer lists start proposing "just recycle it"
  // The destructive-keyword heuristic stays as a fallback for older dumps.
  function isJunkRecipe(recipe) {
    if (!recipe) return true;
    if (recipe.parameter) return true;
    if (recipe.hidden) return true;
    // Recycling needs a scalpel, not an axe. Space Age AUTO-generates "X
    // recycling" for nearly every item (X -> its own ingredients / 4): those are
    // pure noise in a production graph. But scrap recycling on Fulgora is the
    // single most important recipe on the planet - scrap isn't crafted from
    // anything, it's mined, and recycling it is how you PRODUCE half the game.
    // So: a recycling recipe is junk only when it undoes a craft, i.e. when its
    // input is something you can build. Raw input -> keep.
    if (isRecyclingRecipe(recipe)) return !isRawRecyclingInput(recipe);
    // Barreling. Pyanodon has a fill/empty pair for every single fluid, and every
    // one of them is a pure catalyst recipe (barrel in -> same fluid out). In the
    // recipe graph they read as "you can PRODUCE acid gas by emptying a barrel of
    // acid gas", which is circular nonsense and swamps every producer list. Barrels are
    // transport, not production.
    if (/barrel/i.test(recipe.category || "")) return true;
    return isDestructiveRecipe(recipe);
  }

  // Pyanodon's dump has ~10 500 recipes. Scanning all of them on every question
  // ("who makes iron plate?", "who eats it?") - inside loops, several times per
  // render - is what turns a 200ms page into a 3s page. Build the indexes once
  // per dataset instead, and rebuild only when the dataset or the recipe filter
  // actually changes.
  function recipeIndex(dataset) {
    if (!dataset) return { usable: [], producers: new Map(), consumers: new Map() };
    const signature = `${unlockedFilterActive() ? "unlocked" : "all"}`;
    if (dataset._recipeIndex && dataset._recipeIndexSig === signature) return dataset._recipeIndex;

    const usable = [];
    const producers = new Map();
    const consumers = new Map();
    for (const recipe of Object.values(dataset.recipes || {})) {
      if (isJunkRecipe(recipe)) continue;
      // «Только изученные»: dump knows what's researched in THIS save
      // (unlocked_now). Undefined means the mod couldn't tell - never filter then.
      if (unlockedFilterActive() && recipe.unlocked_now === false) continue;
      usable.push(recipe);
      // One entry per recipe per item, NOT per product row: a recipe that lists the
      // same product twice (`fish-mk03-breeder` has item:fish-mk03 at x6 and x2)
      // used to be pushed twice, which showed up as a duplicate "Способ N" card, a
      // duplicate route, and two identical tabs from "выбрать все и объединить".
      const seenProducts = new Set();
      for (const p of asArray(recipe.products)) {
        const key = itemKey(p.type || "item", p.name);
        if (seenProducts.has(key)) continue;
        seenProducts.add(key);
        if (!producers.has(key)) producers.set(key, []);
        producers.get(key).push(recipe);
      }
      const seenIngredients = new Set();
      for (const i of asArray(recipe.ingredients)) {
        const key = itemKey(i.type || "item", i.name);
        if (seenIngredients.has(key)) continue;
        seenIngredients.add(key);
        if (!consumers.has(key)) consumers.set(key, []);
        consumers.get(key).push(recipe);
      }
    }
    dataset._recipeIndex = { usable, producers, consumers };
    dataset._recipeIndexSig = signature;
    return dataset._recipeIndex;
  }

  function invalidateRecipeIndex() {
    if (!state.dataset) return;
    delete state.dataset._recipeIndex;
    delete state.dataset._recipeIndexSig;
    delete state.dataset._itemGraphFwd;
    delete state.dataset._itemGraphRev;
    delete state.dataset._machinesByCategory;
    delete state.dataset._machinesByCategorySig;
    // Список заводов тоже зависит от фильтра «только изученные» — собираем заново.
    delete state.dataset._allMachines;
    delete state.dataset._allMachinesSig;
    delete state.dataset._craftableKeys;
  }

  function isRecyclingRecipe(recipe) {
    return !!recipe.is_recycling || (recipe.category || "").toLowerCase() === "recycling";
  }

  // "Is the thing being recycled a raw material?" - i.e. nothing else in the pack
  // produces it (Fulgora's scrap), as opposed to an item you crafted and are now
  // undoing (everything else). Computed against the raw recipe table, without the
  // junk filter, so there's no chicken-and-egg with the index.
  function isRawRecyclingInput(recipe) {
    const dataset = state.dataset;
    if (!dataset) return false;
    if (!dataset._craftableKeys) {
      const craftable = new Set();
      for (const r of Object.values(dataset.recipes || {})) {
        if (isRecyclingRecipe(r) || r.parameter) continue;
        for (const p of asArray(r.products)) craftable.add(itemKey(p.type || "item", p.name));
      }
      dataset._craftableKeys = craftable;
    }
    const inputs = asArray(recipe.ingredients);
    if (!inputs.length) return false;
    return inputs.every((i) => !dataset._craftableKeys.has(itemKey(i.type || "item", i.name)));
  }

  function usableRecipes(dataset) {
    return recipeIndex(dataset).usable;
  }

  function findRecipesProducing(dataset, key) {
    // The producer index is keyed by plain fluid name (fluid:steam), because
    // the producer lists shouldn't fragment steam into one node per temperature. But an
    // ingredient asks with a temperature (fluid:steam@500:). So for fluids we
    // look up by base name, then keep only recipes whose steam actually comes
    // out hot enough for this demand.
    const parsed = parseFluidKey(key);
    if (parsed && (parsed[1] !== -Infinity || parsed[2] !== Infinity)) {
      const byName = recipeIndex(dataset).producers.get(`fluid:${parsed[0]}`) || [];
      return byName.filter((recipe) =>
        asArray(recipe.products).some((p) => (p.type || "item") === "fluid" && p.name === parsed[0] && fluidOutputSatisfies(specKey(p), key))
      );
    }
    return recipeIndex(dataset).producers.get(key) || [];
  }

  function isMachineEntity(entity) {
    // dump_version >= 2 flags real crafting machines explicitly. Older dumps only
    // contained machines in `entities`, so "has crafting categories" is the
    // fallback - either way, belts/inserters/beacons must never end up in the
    // machine dropdown.
    if (!entity) return false;
    if (entity.is_machine !== undefined) return !!entity.is_machine;
    return asArray(entity.crafting_categories).length > 0 || entity.crafting_speed !== undefined;
  }

  // ---------- изученность заводов ----------
  //
  // У построек в дампе нет поля «изучено», оно есть у рецептов. Завод считается
  // изученным, если изучен рецепт, который его делает: постройка -> предмет
  // (place_result), предмет -> рецепт. Индексы строятся один раз на датасет.
  // Если дамп не знает, что изучено (полный дамп), фильтровать нечем: список
  // заводов показывается весь.

  /** Постройка -> предметы, которые её ставят (item.place_result).
   *
   *  Значением всегда список: в редких сборках одну и ту же постройку ставят
   *  несколько предметов (например «готовый» предмет из другой сборки), и тогда
   *  судить о ней по одному предмету нельзя. */
  function entityItemIndex(dataset) {
    if (!dataset._entityItems) {
      const map = new Map();
      for (const item of Object.values((dataset && dataset.items) || {})) {
        if (!item || !item.place_result) continue;
        if (!map.has(item.place_result)) map.set(item.place_result, []);
        map.get(item.place_result).push(item.name);
      }
      dataset._entityItems = map;
    }
    return dataset._entityItems;
  }

  function itemRecipeIndex(dataset) {
    if (!dataset._itemRecipe) {
      const map = new Map();
      for (const recipe of Object.values((dataset && dataset.recipes) || {})) {
        // parameter — это UI-заглушки 2.0, а не рецепты; всё остальное смотрим,
        // включая скрытое: если предмет делается ТОЛЬКО скрытым рецептом, значит
        // получить его нельзя (в Py так скрыт ванильный химический завод).
        if (!recipe || recipe.parameter) continue;
        const junk = isJunkRecipe(recipe);
        for (const p of asArray(recipe.products)) {
          if (!p || !p.name) continue;
          const key = itemKey(p.type || "item", p.name);
          const prev = map.get(key);
          // Обычный рецепт важнее скрытого/мусорного.
          if (!prev || (prev.junk && !junk)) map.set(key, { recipe, junk });
        }
      }
      dataset._itemRecipe = map;
    }
    return dataset._itemRecipe;
  }

  /** Рецепт завода, по которому о нём судят: обычный важнее скрытого/мусорного. */
  function machineRecipeEntry(dataset, entityName) {
    const itemNames = entityItemIndex(dataset).get(entityName) || [];
    const index = itemRecipeIndex(dataset);
    let fallback = null;
    for (const itemName of itemNames) {
      const entry = index.get(itemKey("item", itemName));
      if (!entry) continue;
      if (!entry.junk) return entry;
      fallback = fallback || entry;
    }
    return fallback;
  }

  /** Можно ли вообще получить этот завод: false — нет, null — из дампа не видно.
   *
   *  Про скрытые рецепты: hidden в прототипе означает «в меню крафта этого нет» —
   *  это правило самой игры, поэтому оно годится для любой сборки, а не только для
   *  Pyanodon (там так скрыт ванильный химический завод). Если предметов-постановщиков
   *  несколько, завод считается доступным, когда хоть один из них крафтится. */
  function machineBuildable(dataset, entityName) {
    const entry = machineRecipeEntry(dataset, entityName);
    if (!entry) return null;              // рецепта нет вовсе — не судим
    return !entry.junk;                   // только скрытый/мусорный рецепт = получить нельзя
  }

  /** Изучен ли этот завод. Неизвестно (нет поля / нет рецепта) — считаем изученным. */
  function machineUnlocked(dataset, entityName) {
    // Завод, который нельзя получить (рецепт скрыт), не «изучен» и не должен
    // подставляться сам — именно так было с ванильным химическим заводом в Py.
    if (machineBuildable(dataset, entityName) === false) return false;
    if (!datasetKnowsUnlocked(dataset)) return true;
    const entry = machineRecipeEntry(dataset, entityName);
    if (!entry || entry.recipe.unlocked_now === undefined || entry.recipe.unlocked_now === null) {
      return true;
    }
    return !!entry.recipe.unlocked_now;
  }

  /** Порядок заводов в списке: первый подставляется в расчёт по умолчанию.
   *
   *  Сначала изученные, затем электрические, затем самый маленький и медленный. В Py под
   *  «химию» подходят и ванильный химический завод (3×3), и «Химический завод МК1» (9×9),
   *  но ванильный в сохранении может быть не изучен.
   */
  function sortMachines(dataset, machines) {
    const rank = (m) => (machineUnlocked(dataset, m.name) ? 0 : 1);
    const rankEnergy = (m) => (String(m.energy_source_type || "").toLowerCase() === "electric" ? 0 : 1);
    const area = (m) => (m.tile_width || 1) * (m.tile_height || 1);
    return machines.slice().sort((a, b) =>
      rank(a) - rank(b)
      || rankEnergy(a) - rankEnergy(b)
      || area(a) - area(b)
      || (a.crafting_speed || 0) - (b.crafting_speed || 0)
      || String(a.name).localeCompare(String(b.name)));
  }

  function allMachines(dataset) {
    const signature = unlockedFilterActive() ? "unlocked" : "all";
    if (!dataset._allMachines || dataset._allMachinesSig !== signature) {
      const machines = Object.values(dataset.entities || {}).filter(isMachineEntity);
      const kept = signature === "unlocked"
        ? machines.filter((m) => machineUnlocked(dataset, m.name))
        : machines;
      dataset._allMachines = sortMachines(dataset, kept);
      dataset._allMachinesSig = signature;
      delete dataset._machinesByCategory;   // список по категориям собран из старого набора
    }
    return dataset._allMachines;
  }

  function compatibleMachines(dataset, recipe) {
    if (!dataset) return [];
    const signature = unlockedFilterActive() ? "unlocked" : "all";
    if (!dataset._machinesByCategory || dataset._machinesByCategorySig !== signature) {
      const byCategory = new Map();
      for (const entity of allMachines(dataset)) {
        for (const cat of asArray(entity.crafting_categories)) {
          if (!byCategory.has(cat)) byCategory.set(cat, []);
          byCategory.get(cat).push(entity);
        }
      }
      dataset._machinesByCategory = byCategory;
      dataset._machinesByCategorySig = signature;
    }
    const list = dataset._machinesByCategory.get(recipe.category || "crafting");
    // Пусто после фильтра — берём полный список: без завода расчёт невозможен, а
    // «изученных заводов под эту категорию нет» бывает только у рецептов, которые
    // сами не изучены (такие просто не предлагаются, когда фильтр включён).
    return list && list.length ? list : allMachines(dataset);
  }

  // Transport belts straight from the dump: belt_speed is already items/sec over
  // both lanes. Beats hardcoding yellow/red/blue, which is meaningless in a
  // modpack with its own belt tiers.
  function datasetBelts(dataset) {
    return Object.values((dataset && dataset.entities) || {})
      .filter((e) => e.type === "transport-belt" && e.belt_speed > 0)
      .sort((a, b) => a.belt_speed - b.belt_speed);
  }

  function renderBeltButtons() {
    const box = document.getElementById("beltButtons");
    if (!box) return;
    const custom = document.getElementById("beltCustom");
    const belts = datasetBelts(state.dataset);
    // Лента сменного набора: подсветка и подпись «в расчёте» должны совпадать с
    // тем, что реально уходит в расчёт — иначе непонятно, по какой ленте считаем.
    const syncCustom = (speed) => {
      if (!custom) return;
      const isTier = !!box.querySelector(`.beltBtn[data-belt="${speed}"]`);
      custom.value = isTier ? "" : speed;
      custom.classList.toggle("active", !isTier);
      renderBeltActiveHint(isTier ? null : speed);
    };
    if (!belts.length) {
      // Old dump: the vanilla yellow/red/blue buttons in the markup are the list.
      const current = state.belt.speed;
      const active = box.querySelector(`.beltBtn[data-belt="${current}"]`);
      if (active) active.classList.add("active");
      syncCustom(current);
      bindBeltButtons();
      return;
    }
    box.innerHTML = belts
      .map((b) => {
        const speed = +b.belt_speed.toFixed(2);
        return `<button class="beltBtn" data-belt="${speed}" title="${b.name}">${iconImg(b.icon_url, 16)}${
          b.display_name || prettify(b.name)
        } · ${speed}/с</button>`;
      })
      .join("");
    // Keep whatever tier was already chosen if the new dataset still has it,
    // otherwise fall back to the slowest belt so nothing is left unselected.
    const current = state.belt.speed;
    let active = box.querySelector(`.beltBtn[data-belt="${current}"]`);
    if (!active) {
      active = box.querySelector(".beltBtn");
      if (active) state.belt.speed = parseFloat(active.dataset.belt);
    }
    if (active) active.classList.add("active");
    syncCustom(state.belt.speed);
    bindBeltButtons();
  }

  // «В расчёте: Красная · 30/с» — чтобы было видно не только по подсветке, тем
  // более что лента может быть задана своим числом (тогда кнопки не активны).
  function renderBeltActiveHint(customSpeed) {
    const hint = document.getElementById("beltActiveHint");
    if (!hint) return;
    const speed = customSpeed != null ? customSpeed : state.belt.speed;
    let label = `${speed}/сек`;
    if (customSpeed == null) {
      const active = document.querySelector(".beltBtn.active");
      if (active) label = `${active.textContent.replace(/^\s*/, "").replace(/\s*·\s*[\d.,]+\/с\s*$/, "")} · ${speed}/сек`;
    }
    hint.innerHTML = `в расчёте: <b>${customSpeed != null ? "своя лента" : label}</b>${customSpeed != null ? ` ${label}` : ""} — вход и выход`;
    hint.classList.toggle("custom", customSpeed != null);
  }

  // ---- раздел «Манипуляторы» --------------------------------------------------
  // Единственный источник правды о манипуляторах: сколько предметов за раз
  // (пачка), с какой скоростью оборачивается, и что из этого получается
  // (заходов/сек и предметов/сек). Значения по умолчанию приходят из дампа, но
  // считается всегда то, что стоит в таблице — дамп про сейв знает не всё
  // (бонус исследований пачки в прототипе не лежит, он в сохранении).
  //
  // Хранится в localStorage по датасету (это свойство набора модов/сейва, а не
  // одной цепочки) и дублируется в сохранённую цепочку, чтобы числа не терялись.
  function inserterBonusFromDump(dataset) {
    const b = (dataset && dataset.inserter_bonus) || null;
    if (!b) return null;
    return { stack: Math.max(0, Number(b.stack) || 0), bulk: Math.max(0, Number(b.bulk) || 0) };
  }
  // Старое имя — пригодится тестам и коду, который читает бонусы из дампа.
  const datasetInserterBonus = inserterBonusFromDump;

  // Раздел «Манипуляторы» общий для всех дампов: настройка привязана к имени манипулятора,
  // поэтому повторный дамп её не сбивает. Старые записи по ключу датасета подхватываются
  // при первой загрузке (см. loadInserterSetup).
  const INSERTER_SETUP_KEY = "chaincalc_inserter_setup";

  function inserterSetupStorageKey(datasetId) {
    return datasetId ? `chaincalc_inserter_setup_${datasetId}` : INSERTER_SETUP_KEY;
  }

  /** Старый флаг off:true — то же, что use:false (галочка снята руками). */
  function normalizeInserterSetup(obj) {
    const out = {};
    if (!obj || typeof obj !== "object") return out;
    for (const [name, v] of Object.entries(obj)) {
      if (!v || typeof v !== "object") continue;
      const cur = { ...v };
      if (cur.off && typeof cur.use !== "boolean") cur.use = false;
      delete cur.off;
      if (Object.keys(cur).length) out[name] = cur;
    }
    return out;
  }

  function loadInserterSetup(datasetId) {
    state.inserterSetup = {};
    try {
      let raw = localStorage.getItem(INSERTER_SETUP_KEY);
      let migrated = false;
      if (raw == null && datasetId) {
        raw = localStorage.getItem(inserterSetupStorageKey(datasetId));
        migrated = raw != null;
      }
      const parsed = raw ? JSON.parse(raw) : null;
      state.inserterSetup = normalizeInserterSetup(parsed);
      if (migrated) saveInserterSetup();
    } catch (e) {
      state.inserterSetup = {};
    }
  }

  function saveInserterSetup() {
    try {
      localStorage.setItem(INSERTER_SETUP_KEY, JSON.stringify(state.inserterSetup || {}));
    } catch (e) {
      /* приватный режим/переполнение — не повод ломать расчёт */
    }
  }

  /** Плашка над выбором лент: можно ли верить числам манипуляторов.
   *
   *  На полном дампе их чисел нет вовсе (только прототипы, без бонуса
   *  исследований), поэтому подбор манипуляторов не работает — об этом надо
   *  сказать до расчёта и до чертежа, а не молчать. Как только человек впишет
   *  числа в разделе «Манипуляторы», плашка гаснет (считается по вписанному). */
  function renderInserterDataWarn() {
    const box = document.getElementById("inserterDataWarn");
    if (!box) return;
    if (!state.dataset || datasetKnowsUnlocked(state.dataset)) {
      box.classList.add("hidden");
      box.classList.remove("warn", "ok");
      box.innerHTML = "";
      return;
    }
    box.classList.remove("hidden");
    if (inserterSetupHasNumbers()) {
      box.classList.remove("warn");
      box.classList.add("ok");
      box.innerHTML =
        `дамп полный — чисел манипуляторов в нём нет. Считаю по тому, что вписано в разделе ` +
        `<b>«Манипуляторы»</b> (у тех, что с галочкой): пачка и скорость берутся оттуда, а не из дампа.`;
      return;
    }
    box.classList.remove("ok");
    box.classList.add("warn");
    box.innerHTML =
      `⚠ <b>дамп полный: подбор манипуляторов не работает</b> — в нём только прототипы, без бонуса исследований, ` +
      `поэтому «сколько за раз» взять негде, а что изучено — неизвестно, и галочки сняты со всех манипуляторов. ` +
      `Открой раздел <b>«Манипуляторы»</b>, впиши <b>скорость</b> и <b>сколько за раз</b> тех, что у тебя есть, и поставь на них галочки. ` +
      `Пока таких нет, в чертёж компоновки и в сундук запроса ` +
      `манипуляторы <b>не ставятся вовсе</b> (ленты, заводы и столбы встанут — манипуляторы поставишь сам).`;
  }

  /** Записать пачку и/или скорость (в об/тик) для одного манипулятора.
   *  null/0/пусто — снять ручное значение и вернуться к дампу. */
  function setInserterSetup(name, patch) {
    if (!name || !patch) return;
    const next = { ...(state.inserterSetup || {}) };
    const cur = { ...(next[name] || {}) };
    for (const key of ["hand", "speed"]) {
      if (!(key in patch)) continue;
      const v = Number(patch[key]);
      if (isFinite(v) && v > 0) cur[key] = key === "hand" ? Math.floor(v) : v;
      else delete cur[key];
    }
    // Вписанные числа включают манипулятор (если он ещё не включён).
    if ((cur.hand > 0 || cur.speed > 0) && typeof cur.use !== "boolean" && inserterIsOff(name)) cur.use = true;
    if (Object.keys(cur).length) next[name] = cur;
    else delete next[name];
    state.inserterSetup = next;
    saveInserterSetup();
  }

  function resetInserterSetup(name) {
    if (!name) return;
    const next = { ...(state.inserterSetup || {}) };
    delete next[name];
    state.inserterSetup = next;
    saveInserterSetup();
  }

  function resetAllInserterSetup() {
    state.inserterSetup = {};
    saveInserterSetup();
  }

  /** Галочка «участвует»: снятая галочка убирает манипулятор из рекомендаций
   *  (авто-выбор) и из выпадающих списков в карточках — но строка в таблице
   *  остаётся, чтобы галочку можно было вернуть. */
  function inserterIsOff(name) {
    const s = inserterSetupFor(name);
    if (s && typeof s.use === "boolean") return !s.use;
    if (s && s.off) return true; // старая запись до нормализации
    return !inserterDefaultUse(name);
  }

  /** Что изучено в сохранении: имена продуктов всех рецептов и только изученных. */
  function unlockedProductNames(dataset) {
    if (!dataset._unlockedProducts) {
      const made = new Set();
      const open = new Set();
      for (const r of Object.values(dataset.recipes || {})) {
        if (!r) continue;
        for (const p of asArray(r.products)) {
          if (!p || !p.name) continue;
          made.add(p.name);
          if (r.unlocked_now) open.add(p.name);
        }
      }
      dataset._unlockedProducts = { made, open };
    }
    return dataset._unlockedProducts;
  }

  /** Галочка по умолчанию, пока её не меняли вручную: в дампе из сохранения стоит у
   *  изученных (предмет без рецепта считается доступным), в полном дампе снята у всех. */
  function inserterDefaultUse(name) {
    const ds = state.dataset;
    if (!ds) return true;
    if (!datasetKnowsUnlocked(ds)) return false;
    return itemResearchedInSave(name);
  }

  /** Изучен ли предмет в сохранении: есть изученный рецепт, который его делает, а
   *  предмет вообще без рецепта считаем доступным. Только для дампа из сохранения. */
  function itemResearchedInSave(name) {
    const ds = state.dataset;
    if (!ds) return true;
    const { made, open } = unlockedProductNames(ds);
    return open.has(name) || !made.has(name);
  }

  // ---- тип трубы для блюпринтов (Настройки) ---------------------------------------
  // Виды труб знает геометрия (сервер: /api/pipe_types), а название и иконку берём у
  // предмета из дампа. В дампе из сохранения в списке только изученные, в полном — все.

  const PIPE_TYPE_KEY = "chaincalc_pipe_type";

  /** Виды труб, из которых можно выбирать, для текущего дампа. */
  function pipeOptions() {
    const types = state.pipeTypes || [];
    const ds = state.dataset;
    const knows = !!ds && datasetKnowsUnlocked(ds);
    const items = (ds && ds.items) || {};
    return types
      .map((t) => {
        const item = items[t.name] || {};
        return {
          ...t,
          label: item.display_name || prettify(t.name),
          icon: item.icon_url || null,
          available: !knows || itemResearchedInSave(t.name),
        };
      })
      .filter((t) => t.available);
  }

  /** Выбранная труба: сохранённый выбор, если он есть в списке, иначе прямая труба,
   *  иначе первая доступная. null — видов труб нет (сервер сам возьмёт обычную). */
  function selectedPipe() {
    const options = pipeOptions();
    if (!options.length) return null;
    let stored = state.pipeType;
    if (stored === undefined) {
      try {
        stored = localStorage.getItem(PIPE_TYPE_KEY);
      } catch (e) {
        stored = null;
      }
      state.pipeType = stored;
    }
    const found = options.find((o) => o.name === stored) || options.find((o) => o.name === "pipe") || options[0];
    return found;
  }

  function setPipeType(name) {
    state.pipeType = name;
    try {
      localStorage.setItem(PIPE_TYPE_KEY, name);
    } catch (e) {
      /* не запомнится между сессиями — не страшно */
    }
  }

  async function ensurePipeTypes() {
    if (state.pipeTypes || state.pipeTypesLoading) return;
    state.pipeTypesLoading = true;
    try {
      const response = await apiFetch("/api/pipe_types");
      const data = await response.json().catch(() => null);
      state.pipeTypes = response.ok && data && Array.isArray(data.pipes) ? data.pipes : [];
      state.pipeTypesError = response.ok ? "" : (data && data.error) || `сервер ответил ${response.status}`;
    } catch (e) {
      state.pipeTypes = [];
      state.pipeTypesError = `ошибка запроса: ${e}`;
    }
    state.pipeTypesLoading = false;
    renderPipeSetting();
  }

  function pipeOptionHTML(option, current) {
    return (
      `<button type="button" role="option" class="pipePickOption${option.name === current ? " active" : ""}" ` +
      `data-pipe="${option.name}" aria-selected="${option.name === current}">` +
      `${iconImg(option.icon, 22)}<span>${option.label}</span></button>`
    );
  }

  function renderPipeSetting() {
    const btn = document.getElementById("pipePickBtn");
    const list = document.getElementById("pipePickList");
    const hint = document.getElementById("pipePickHint");
    if (!btn || !list) return;
    if (!state.pipeTypes) {
      btn.innerHTML = "…";
      ensurePipeTypes();
      return;
    }
    const options = pipeOptions();
    const current = selectedPipe();
    if (!options.length) {
      btn.innerHTML = "—";
      btn.disabled = true;
      list.innerHTML = "";
      if (hint) {
        hint.textContent = state.pipeTypesError
          ? `— ${state.pipeTypesError}`
          : state.dataset
          ? "— в дампе нет изученных труб"
          : "— датасет не загружен";
      }
      return;
    }
    btn.disabled = false;
    btn.innerHTML = `${iconImg(current.icon, 22)}<span>${current.label}</span><span class="pipePickCaret">▾</span>`;
    list.innerHTML = options.map((o) => pipeOptionHTML(o, current.name)).join("");
    if (hint) {
      hint.textContent =
        state.dataset && datasetKnowsUnlocked(state.dataset)
          ? "— только изученные"
          : state.dataset
          ? "— все виды (полный дамп не знает, что изучено)"
          : "";
    }
  }

  function togglePipeList(open) {
    const list = document.getElementById("pipePickList");
    const btn = document.getElementById("pipePickBtn");
    if (!list || !btn) return;
    const show = open === undefined ? list.classList.contains("hidden") : !!open;
    list.classList.toggle("hidden", !show);
    btn.setAttribute("aria-expanded", String(show));
  }

  function setInserterEnabled(name, enabled) {
    if (!name) return;
    const next = { ...(state.inserterSetup || {}) };
    const cur = { ...(next[name] || {}) };
    delete cur.off;
    cur.use = !!enabled;
    if (Object.keys(cur).length) next[name] = cur;
    else delete next[name];
    state.inserterSetup = next;
    saveInserterSetup();
  }

  function inserterSpeedUnit() {
    return ["turns", "deg", "sec"].includes(state.inserterSpeedUnit) ? state.inserterSpeedUnit : "turns";
  }

  function speedUnitLabel(unit) {
    // «°/сек» — то, что показывает сама игра (тултип/Фактопедия): rotation_speed × 21600.
    return unit === "deg" ? "°/сек" : unit === "sec" ? "сек/об" : "об/тик";
  }

  /** Число для поля ввода: как в выбранной единице, с разумным округлением. */
  function speedFieldValue(turns, unit) {
    const v = turnsToSpeed(turns, unit);
    if (!(v > 0)) return "";
    if (unit === "deg") return String(+v.toFixed(v >= 100 ? 0 : 2));
    const digits = unit === "sec" ? 3 : 5;
    return String(+v.toFixed(digits));
  }

  // ---- сортировка таблицы ----------------------------------------------------
  // Клик по заголовку «за раз» / «скорость» / «предметов/сек» сортирует строки;
  // повторный клик переворачивает порядок. Манипуляторы со снятой галочкой в
  // сортировке НЕ участвуют — они всегда идут после всех, у кого галочка стоит.
  const INS_SORT_KEYS = ["hand", "speed", "total"];

  function inserterSortState() {
    const s = state.inserterSort || {};
    return {
      key: INS_SORT_KEYS.includes(s.key) ? s.key : "total",
      dir: s.dir === "asc" ? "asc" : "desc",
    };
  }

  function setInserterSort(key) {
    if (!INS_SORT_KEYS.includes(key)) return;
    const cur = inserterSortState();
    // Новый столбец — сначала по убыванию (сразу видно самых «сильных»),
    // повторный клик по тому же — наоборот.
    const dir = cur.key === key ? (cur.dir === "desc" ? "asc" : "desc") : "desc";
    state.inserterSort = { key, dir };
    try {
      localStorage.setItem("chaincalc_inserter_sort", JSON.stringify(state.inserterSort));
    } catch (e) {
      /* приватный режим — не повод ломать таблицу */
    }
  }

  function loadInserterSort() {
    try {
      const raw = localStorage.getItem("chaincalc_inserter_sort");
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object" && INS_SORT_KEYS.includes(parsed.key)) {
        state.inserterSort = { key: parsed.key, dir: parsed.dir === "asc" ? "asc" : "desc" };
      }
    } catch (e) {
      /* мусор в localStorage игнорируем */
    }
  }

  /** Строки таблицы: с галочкой — по выбранному столбцу, без галочки — всегда
   *  после них и в порядке по умолчанию (в сортировке они не участвуют). */
  function sortInserterRows(rows) {
    const { key, dir } = inserterSortState();
    const value = (r) => (key === "hand" ? r.hand : key === "speed" ? r.rotationSpeed : r.throughput);
    const byKey = (a, b) => {
      const d = (value(a) || 0) - (value(b) || 0);
      if (d !== 0) return dir === "asc" ? d : -d;
      return a.label.localeCompare(b.label);
    };
    const on = rows.filter((r) => !r.off).sort(byKey);
    const off = rows
      .filter((r) => r.off)
      .slice()
      .sort((a, b) => (b.throughput || 0) - (a.throughput || 0) || a.label.localeCompare(b.label));
    return [...on, ...off];
  }

  function inserterSortHeaderHTML(key, label, title) {
    const sort = inserterSortState();
    const active = sort.key === key;
    return `<th class="insSortable${active ? " active" : ""}" data-sort="${key}" title="${title} — нажми, чтобы отсортировать${
      active ? " (повторный клик — в обратном порядке)" : ""
    }; манипуляторы без галочки в сортировке не участвуют и всегда идут ниже">${label}<span class="insSortArrow">${
      active ? (sort.dir === "desc" ? "▼" : "▲") : "↕"
    }</span></th>`;
  }

  function renderInserterTable() {
    const box = document.getElementById("inserterTable");
    if (!box) return;
    // Правки тут же видны и в плашке над выбором лент: пока чисел нет — подбор
    // не работает, как только вписали — считается по вписанному.
    renderInserterDataWarn();
    const unit = inserterSpeedUnit();
    const sel = document.getElementById("inserterSpeedUnit");
    if (sel) sel.value = unit;
    const hint = document.getElementById("inserterSetupHint");
    if (!state.dataset) {
      box.innerHTML = `<p class="hint msg">Сначала загрузи датасет — таблица строится по манипуляторам из него.</p>`;
      if (hint) hint.textContent = "";
      return;
    }
    renderInserterOffer();
    const rows = sortInserterRows(buildDeviceCatalogAll());
    const dumpBonus = inserterBonusFromDump(state.dataset);
    const manual = rows.filter((r) => r.handFromSetup || r.speedFromSetup).length;
    const offCount = rows.filter((r) => r.off).length;
    if (hint) {
      hint.innerHTML = `манипуляторов и погрузчиков: <b>${rows.length}</b>${
        manual ? `, из них правлено руками: <b>${manual}</b>` : ""
      }${
        offCount ? ` · <b>выключено: ${offCount}</b> (не участвуют в рекомендациях и в списках выбора)` : ""
      }${
        dumpBonus
          ? ` · дамп принёс бонус исследований: обычные +${dumpBonus.stack}, массовые +${dumpBonus.bulk}`
          : ` · <b>бонус исследований в дампе не пришёл</b> (${
              datasetKnowsUnlocked(state.dataset) ? "дамп из сохранения, но старый" : "это полный дамп игры — в нём только прототипы"
            }), поэтому пачка по умолчанию 1 — впиши как в игре`
      }`;
    }
    box.innerHTML =
      `<table class="insTable"><thead><tr>` +
      `<th title="Галочка снята — манипулятор или погрузчик не предлагается и не показывается в выпадающих списках. В дампе из сохранения галочки стоят у изученных, в полном дампе сняты со всех">учёт</th>` +
      `<th>манипулятор</th>` +
      inserterSortHeaderHTML("hand", "за раз", "Сколько предметов берёт за один заход (с учётом исследований)") +
      inserterSortHeaderHTML(
        "speed",
        `скорость, ${speedUnitLabel(unit)}`,
        "Скорость оборота. В прототипе игры это доля оборота за тик (rotation_speed), а игра показывает то же в °/с"
      ) +
      `<th title="Сколько заходов успевает за секунду">заходов/сек</th>` +
      inserterSortHeaderHTML("total", "предметов/сек", "Сколько предметов переносит за секунду: заходы × пачка") +
      `<th>из дампа</th><th></th>` +
      `</tr></thead><tbody>` +
      rows.map((r) => inserterTableRowHTML(r, unit)).join("") +
      `</tbody></table>`;
  }

  function inserterTableRowHTML(r, unit) {
    if (r.loader) {
      const note = r.derived ? `скорость по тиру ленты «${r.beltLabel}»` : `скорость ленты своего тира`;
      return (
        `<tr${r.off ? ` class="insRowOff"` : ""}>` +
        `<td class="insUseCell"><input type="checkbox" class="insUse" data-name="${r.name}" ${
          r.off ? "" : "checked"
        } title="Учитывать этот погрузчик: снятая галочка убирает его из рекомендаций и из выпадающих списков в карточках" /></td>` +
        `<td class="insName">${iconImg(r.icon, 18)} ${r.label} <span class="insTag">погрузчик</span>${
          r.off ? ` <span class="insTag insTagOff">не учитывается</span>` : ""
        }</td>` +
        `<td class="insCalc">—</td><td class="insCalc">—</td><td class="insCalc">—</td>` +
        `<td class="insCalc insTotal"><b>${r.throughput > 0 ? r.throughput.toFixed(2) : "—"}</b></td>` +
        `<td class="hint">${note}</td>` +
        `<td><button type="button" class="btn btn-ghost insReset" data-name="${r.name}" title="Вернуть галочку к умолчанию дампа">↺</button></td>` +
        `</tr>`
      );
    }
    const ticks = r.rotationSpeed > 0 ? Math.max(2, Math.floor(1 / r.rotationSpeed + 1e-9)) : 0;
    const evenTicks = ticks > 0 ? (ticks % 2 === 1 ? ticks - 1 : ticks) : 0;
    const swings = evenTicks > 0 ? 60 / evenTicks : 0;
    // В колонке «из дампа» показываем прототипное число и его же в градусах за
    // секунду — так видно и что лежит в дампе, и то, что показывает игра.
    const dumpBits = [];
    if (r.dumpSpeed > 0) {
      dumpBits.push(
        `<b>${+r.dumpSpeed.toFixed(5)} об/тик</b> = ${(r.dumpSpeed * DEG_PER_SEC_PER_TURN).toFixed(1)} °/сек = ${speedFieldValue(
          r.dumpSpeed,
          "sec"
        )} сек/об`
      );
    } else {
      dumpBits.push("скорости нет");
    }
    dumpBits.push(`пачка ${r.dumpHand}`);
    const unitHint =
      unit === "deg"
        ? "Градусы в секунду — как показывает игра (rotation_speed × 21600)"
        : unit === "sec"
        ? "Сколько секунд длится один заход (оборот)"
        : "Доля полного оборота за тик — как в прототипе игры (rotation_speed)";
    const speedCell =
      r.speedFromSetup || r.rotationSpeed > 0
        ? `<input type="number" step="any" min="0" class="input insInput insSpeed" data-name="${r.name}" value="${speedFieldValue(
            r.rotationSpeed,
            unit
          )}" title="Скорость оборота, ${speedUnitLabel(unit)}. ${unitHint}" />`
        : `<input type="number" step="any" min="0" class="input insInput insSpeed" data-name="${r.name}" value="" placeholder="впиши" title="В дампе скорости нет — впиши её в ${speedUnitLabel(
            unit
          )}. ${unitHint}" />`;
    const rowClasses = [];
    if (!(r.throughput > 0)) rowClasses.push("insRowBad");
    if (r.off) rowClasses.push("insRowOff");
    const rowClass = rowClasses.length ? ` class="${rowClasses.join(" ")}"` : "";
    return (
      `<tr${rowClass}>` +
      `<td class="insUseCell"><input type="checkbox" class="insUse" data-name="${r.name}" ${
        r.off ? "" : "checked"
      } title="Учитывать этот манипулятор: снятая галочка убирает его из рекомендаций и из выпадающих списков в карточках" /></td>` +
      `<td class="insName">${iconImg(r.icon, 18)} ${r.label}${r.bulk ? ` <span class="insTag">массовый</span>` : ""}${
        r.off ? ` <span class="insTag insTagOff">не учитывается</span>` : ""
      }</td>` +
      `<td><input type="number" step="1" min="1" class="input insInput insHand" data-name="${r.name}" value="${r.hand}" title="Сколько предметов за один заход" /></td>` +
      `<td>${speedCell}</td>` +
      `<td class="insCalc">${swings > 0 ? `${swings.toFixed(2)} <span class="hint">(${evenTicks} тик.)</span>` : "—"}</td>` +
      `<td class="insCalc insTotal"><b>${r.throughput > 0 ? r.throughput.toFixed(2) : "—"}</b></td>` +
      `<td class="hint">${dumpBits.join(" · ")}${r.handFromSetup || r.speedFromSetup ? ` <span class="insTag">правлено</span>` : ""}</td>` +
      `<td><button type="button" class="btn btn-ghost insReset" data-name="${r.name}" title="Вернуть к значениям из дампа и включить обратно">↺</button></td>` +
      `</tr>`
    );
  }

  // ---- «повторный дамп»: предложить обновить настроенные руками ----------------
  // Новая загрузка дампа настройку не сбивает. Но если дамп другой (изучено новое,
  // пришли другие числа) и вручную настроенные манипуляторы с ним расходятся,
  // один раз предлагаем вернуть их к дампу. Отказ — настройка остаётся как есть.

  const INSERTER_DUMP_SEEN_KEY = "chaincalc_inserter_dump_seen";

  /** Манипуляторы/погрузчики, у которых ручная настройка расходится с дампом. */
  function computeInserterOffer() {
    const ds = state.dataset;
    const setup = state.inserterSetup || {};
    if (!ds || !Object.keys(setup).length) return [];
    const trustHand = datasetKnowsUnlocked(ds);
    const out = [];
    for (const row of buildDeviceCatalogAll()) {
      const s = setup[row.name];
      if (!s) continue;
      const what = [];
      if (typeof s.use === "boolean" && s.use !== inserterDefaultUse(row.name)) what.push("галочка");
      if (!row.loader) {
        if (trustHand && s.hand > 0 && Math.floor(s.hand) !== row.dumpHand) what.push("пачка");
        if (s.speed > 0 && row.dumpSpeed > 0 && Math.abs(s.speed - row.dumpSpeed) > 1e-9) what.push("скорость");
      }
      if (what.length) out.push({ name: row.name, label: row.label, what });
    }
    return out;
  }

  /** Короткий отпечаток того, что дамп говорит про манипуляторы: меняется, когда
   *  загружен другой дамп. */
  function inserterDumpFingerprint() {
    const str = buildDeviceCatalogAll()
      .map((r) => `${r.name}:${inserterDefaultUse(r.name) ? 1 : 0}:${r.dumpHand}:${r.dumpSpeed}`)
      .join("|");
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return `${datasetKnowsUnlocked(state.dataset) ? "save" : "full"}:${h.toString(36)}`;
  }

  function refreshInserterOffer() {
    state.inserterOffer = null;
    if (!state.dataset) return;
    const fp = inserterDumpFingerprint();
    let prev = null;
    try {
      prev = localStorage.getItem(INSERTER_DUMP_SEEN_KEY);
      localStorage.setItem(INSERTER_DUMP_SEEN_KEY, fp);
    } catch (e) {
      /* без localStorage прошлый дамп не помним — и предлагать нечего */
    }
    if (prev === null || prev === fp) return; // первый дамп или тот же самый
    const diffs = computeInserterOffer();
    if (diffs.length) state.inserterOffer = diffs;
  }

  /** Вернуть названные манипуляторы к дампу (снять ручные галочку и числа). */
  function applyInserterOffer() {
    const diffs = state.inserterOffer || [];
    const next = { ...(state.inserterSetup || {}) };
    for (const d of diffs) delete next[d.name];
    state.inserterSetup = next;
    state.inserterOffer = null;
    saveInserterSetup();
  }

  function renderInserterOffer() {
    const box = document.getElementById("inserterUpdateOffer");
    if (!box) return;
    const diffs = state.inserterOffer;
    if (!diffs || !diffs.length) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    const names = diffs.slice(0, 6).map((d) => `${d.label} (${d.what.join(", ")})`).join("; ");
    box.classList.remove("hidden");
    box.innerHTML =
      `Загружен другой дамп, а настроенные вручную манипуляторы с ним расходятся: <b>${diffs.length}</b> — ${names}${
        diffs.length > 6 ? "…" : ""
      }. Обновить их до дампа? ` +
      `<button type="button" class="btn btn-primary" id="inserterOfferApply">Обновить до дампа</button> ` +
      `<button type="button" class="btn btn-ghost" id="inserterOfferKeep">Оставить мои</button>`;
  }

  function bindInserterOffer() {
    const box = document.getElementById("inserterUpdateOffer");
    if (!box || box.dataset.bound) return;
    box.dataset.bound = "1";
    box.addEventListener("click", (e) => {
      const apply = e.target.closest("#inserterOfferApply");
      const keep = e.target.closest("#inserterOfferKeep");
      if (!apply && !keep) return;
      safeCall(() => {
        if (apply) applyInserterOffer();
        else state.inserterOffer = null;
        state.dirty = true;
        renderInserterTable();
        renderResults();
        renderInputResources();
      });
    });
  }

  function bindInserterTable() {
    bindInserterOffer();
    const box = document.getElementById("inserterTable");
    if (!box || box.dataset.bound) return;
    box.dataset.bound = "1";
    box.addEventListener("change", (e) => {
      const use = e.target.closest(".insUse");
      const hand = e.target.closest(".insHand");
      const speed = e.target.closest(".insSpeed");
      if (!use && !hand && !speed) return;
      safeCall(() => {
        if (use) {
          // Снятая галочка = «этот манипулятор у меня не используется»: он уходит
          // из рекомендаций (авто-выбор) и из выпадающих списков в карточках.
          setInserterEnabled(use.dataset.name, use.checked);
          state.dirty = true;
          renderInserterTable();
          renderResults();
          renderInputResources();
          return;
        }
        const name = (hand || speed).dataset.name;
        if (hand) setInserterSetup(name, { hand: hand.value });
        else {
          const unit = inserterSpeedUnit();
          setInserterSetup(name, { speed: speedToTurns(speed.value, unit) || 0 });
        }
        state.dirty = true;
        // Это раскладка (сколько манипуляторов нужно), а не производительность:
        // заводы и цепочку пересчитывать не надо, достаточно перерисовать.
        renderInserterTable();
        renderResults();
        renderInputResources();
      });
    });
    box.addEventListener("click", (e) => {
      const sortTh = e.target.closest(".insSortable");
      if (sortTh) {
        safeCall(() => {
          setInserterSort(sortTh.dataset.sort);
          renderInserterTable(); // сортировка — только вид таблицы, расчёт не трогаем
        });
        return;
      }
      const btn = e.target.closest(".insReset");
      if (!btn) return;
      safeCall(() => {
        resetInserterSetup(btn.dataset.name);
        state.dirty = true;
        renderInserterTable();
        renderResults();
        renderInputResources();
      });
    });
    const unitSel = document.getElementById("inserterSpeedUnit");
    if (unitSel && !unitSel.dataset.bound) {
      unitSel.dataset.bound = "1";
      unitSel.addEventListener("change", () =>
        safeCall(() => {
          state.inserterSpeedUnit = unitSel.value;
          localStorage.setItem("chaincalc_inserter_speed_unit", inserterSpeedUnit());
          renderInserterTable();
        })
      );
    }
    const resetAll = document.getElementById("resetInserterSetupBtn");
    if (resetAll && !resetAll.dataset.bound) {
      resetAll.dataset.bound = "1";
      resetAll.addEventListener("click", () =>
        safeCall(() => {
          resetAllInserterSetup();
          state.dirty = true;
          renderInserterTable();
          renderResults();
          renderInputResources();
        })
      );
    }
    unitSelSetInitial();
  }

  function unitSelSetInitial() {
    const stored = localStorage.getItem("chaincalc_inserter_speed_unit");
    if (stored && ["turns", "deg", "sec"].includes(stored)) state.inserterSpeedUnit = stored;
    loadInserterSort();
  }

  // "Только изученные" is only meaningful if the mod could actually tell what's
  // researched (it needs a player in the save). If every recipe came back with
  // unlocked_now === undefined, hide the checkbox rather than offer a lie.
  function renderRecipeFilter() {
    const box = document.getElementById("onlyUnlocked");
    const hint = document.getElementById("recipeCountHint");
    const row = box && box.closest(".recipeFilterRow");
    if (!box || !row) return;
    const recipes = Object.values((state.dataset && state.dataset.recipes) || {});
    const knowsUnlocked = datasetKnowsUnlocked(state.dataset);
    row.classList.toggle("hidden", !knowsUnlocked);
    if (!knowsUnlocked) {
      state.onlyUnlocked = false;
      return;
    }
    box.checked = !!state.onlyUnlocked;
    if (hint) {
      const usable = usableRecipes(state.dataset).length;
      const unlocked = recipes.filter((r) => r.unlocked_now).length;
      hint.textContent = `— в работе ${usable} рецептов из ${recipes.length} (изучено ${unlocked})`;
    }
  }

  // ---------- «только изученные»: настройка и галочка поиска рецепта ----------
  //
  // Две независимые вещи:
  //   * «Настройки → везде показывать только изученные рецепты» — общая настройка,
  //     на неё смотрит расчёт и всё остальное, кроме поиска рецепта;
  //   * галочка на «Поиске рецепта» — только про поиск: если её снять, он найдёт и
  //     неизученные рецепты, расчёт не меняется.
  // Если дамп не знает, что изучено (полный дамп), фильтровать нечем: настройка не
  // работает, об этом пишется в интерфейсе.

  /** Знает ли дамп, что изучено (у рецептов есть unlocked_now). */  function datasetKnowsUnlocked(dataset) {
    if (!dataset) return false;
    // Ответ кэшируем: спрашивают его на каждый завод, а перебор 10 000 рецептов
    // на каждый вызов — это десятки секунд на дампе Py.
    if (dataset._knowsUnlocked === undefined) {
      dataset._knowsUnlocked = Object.values(dataset.recipes || {}).some(
        (r) => r && r.unlocked_now !== undefined && r.unlocked_now !== null
      );
    }
    return dataset._knowsUnlocked;
  }

  /** Есть ли в таблице «Манипуляторы» хоть какие-то вписанные числа.
   *
   *  Полный дамп приносит только прототипы (без бонуса исследований), пачку оттуда взять
   *  негде; вписанные вручную числа её заменяют. */
  function inserterSetupHasNumbers() {
    const setup = state.inserterSetup || {};
    return Object.keys(setup).some((name) => {
      const s = setup[name] || {};
      return ((Number(s.hand) > 0) || (Number(s.speed) > 0)) && !inserterIsOff(name);
    });
  }

  /** Можно ли верить числам манипуляторов.
   *
   *  Дамп из сохранения знает бонус исследований и пачку, поэтому числа берутся из него
   *  (с правками пользователя поверх, см. inserterNumbers). Полный дамп пачки не знает:
   *  тогда верно только то, что вписано в разделе «Манипуляторы». Пока там пусто, подбор
   *  манипуляторов не работает, а в чертёж и сундук запроса они не ставятся. */
  function inserterNumbersReliable() {
    if (datasetKnowsUnlocked(state.dataset)) return true;
    return inserterSetupHasNumbers();
  }

  /** Действует ли фильтр «только изученные» для того раздела, который открыт. */
  function unlockedFilterActive() {
    return state.mode === "search" ? !!state.onlyUnlocked : !!state.settingsOnlyUnlocked;
  }

  /** Включить/выключить галочку «только изученные» на поиске рецепта. */
  function setSearchUnlocked(flag) {
    state.onlyUnlocked = !!flag;
    if (state.datasetId) {
      try {
        localStorage.setItem(`chaincalc_only_unlocked_${state.datasetId}`, flag ? "1" : "0");
      } catch (e) {
        // localStorage недоступен — галочка просто не запомнится между сессиями
      }
    }
    invalidateRecipeIndex();
    const box = document.getElementById("onlyUnlocked");
    if (box) box.checked = !!state.onlyUnlocked;
  }

  /** Что показать рядом с настройкой: про полный дамп пишем, про дамп из сейва — нет. */
  function renderSettings() {
    renderAccount(state.account);       // блок «Кабинет» на этой же вкладке
    renderPipeSetting();
    const hintsBox = document.getElementById("settingsHideHints");
    if (hintsBox) hintsBox.checked = !!state.hideHints;
    const box = document.getElementById("settingsOnlyUnlocked");
    if (!box) return;
    const hint = document.getElementById("settingsOnlyUnlockedHint");
    box.checked = !!state.settingsOnlyUnlocked;
    if (!hint) return;
    if (!state.dataset) {
      hint.textContent = "— датасет не загружен";
      hint.classList.remove("warn");
      return;
    }
    if (!datasetKnowsUnlocked(state.dataset)) {
      hint.textContent =
        "— этот дамп не знает, что изучено (полный дамп игры), поэтому настройка не работает: загрузи дамп из сохранения (в игре /dump-factorio-data)";
      hint.classList.add("warn");
      return;
    }
    hint.textContent = "";        // дамп из сохранения: ничего не пишем
    hint.classList.remove("warn");
  }

  /** Настройка изменилась: применяем её к странице и к галочке поиска рецепта. */
  function applySettingsOnlyUnlocked(flag) {
    state.settingsOnlyUnlocked = !!flag;
    try {
      localStorage.setItem(SETTINGS_UNLOCKED_KEY, flag ? "1" : "0");
    } catch (e) {
      // localStorage недоступен — настройка просто не запомнится между сессиями
    }
    invalidateRecipeIndex();
    // «Если эта галочка стоит и работает, то на вкладке „Поиск рецепта“ она тоже стоит».
    // Работает она только с дампом из сохранения — иначе включать нечего.
    if (datasetKnowsUnlocked(state.dataset)) setSearchUnlocked(!!flag);
    renderSettings();
    renderRecipeFilter();
    renderRecipeSearch();
  }

  /** Настройка «убирать описания»: прячем длинные пояснения, оставляя цифры.
   *
   * Ничего не перерисовываем: класс на <body> — и стили сами убирают абзацы,
   * врезки и подсказки у лент. Так настройка действует и на уже нарисованные
   * карточки, и на те, что появятся после пересчёта. */
  function applyHideHints(flag) {
    state.hideHints = !!flag;
    try {
      localStorage.setItem(SETTINGS_HIDE_HINTS_KEY, flag ? "1" : "0");
    } catch (e) {
      // localStorage недоступен — настройка не запомнится между сессиями
    }
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.toggle("hideHints", state.hideHints);
    }
    const box = document.getElementById("settingsHideHints");
    if (box) box.checked = state.hideHints;
    return state.hideHints;
  }

  /** Что это за дамп: из сохранения (знает изученное) или полный (только прототипы). */
  function dumpKindText(dataset) {
    const recipes = Object.values((dataset && dataset.recipes) || {});
    if (!recipes.length) return "дамп без рецептов";
    if (!datasetKnowsUnlocked(dataset)) {
      // Про «только прототипы» не пишется: это ясно из первой половины фразы, а место в
      // шапке ограничено.
      return "дамп полный - что изучено не известно";
    }
    const unlocked = recipes.filter((r) => r.unlocked_now).length;
    return `дамп из сохранения: изучено ${unlocked} рецептов из ${recipes.length}`;
  }

  /** Подпись в шапке: что за дамп, сколько в нём изучено и когда он загружен.
   *
   *  Число рецептов и версия дампа не показываются. «Загружен» — имя дампа (у выгрузки из
   *  игры это его дата). Предупреждение про старый дамп остаётся: часть чисел в нём
   *  считается приблизительно.
   */
  function datasetStatusText(id, data) {
    const version = (data && data.dump_version) || 1;
    const oldDump =
      version < 2
        ? " · старый дамп (модули/энергия считаются приблизительно)"
        : version < 4
        ? " · без пачки манипуляторов (впиши её у ленты, если массовые качались)"
        : "";
    return `${dumpKindText(data)}. загружен: ${id}${oldDump}`;
  }

  /** Начальное значение галочки поиска рецепта для загруженного датасета. */
  function searchUnlockedInitial(datasetId) {
    const stored = localStorage.getItem(`chaincalc_only_unlocked_${datasetId}`);
    if (stored !== null) return stored === "1";     // игрок уже решал это сам
    // Галочку ещё не меняли: если в настройках включено «везде», она стоит и здесь, но на
    // поиске рецепта её можно снять.
    return !!state.settingsOnlyUnlocked && datasetKnowsUnlocked(state.dataset);
  }

  function bindBeltButtons() {
    document.querySelectorAll(".beltBtn").forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () =>
        safeCall(() => {
          state.belt.speed = parseFloat(btn.dataset.belt);
          state.inputPairs = {}; // capacity changed - old pairing choice may no longer make sense
          state.dirty = true;
          document.querySelectorAll(".beltBtn").forEach((b) => b.classList.toggle("active", b === btn));
          const custom = document.getElementById("beltCustom");
          if (custom) {
            custom.value = "";
            custom.classList.remove("active");
          }
          renderBeltActiveHint(null);
          renderResults();
          renderInputResources();
        })
      );
    });
  }

  // Machines that run on fuel rather than the grid need that fuel DELIVERED, on
  // top of whatever the recipe itself consumes. Two flavours, and until now only
  // the first one existed here:
  //   * solid fuel  - coal/wood into a burner (belt or inserter feed)
  //   * FLUID fuel  - Pyanodon's drills run on gas; the fluid arrives by pipe.
  //     dump_version >= 2 carries fluids' fuel_value and the machine's
  //     fluid_energy_source, so this is finally computable.
  // Every fuel entry gets a `_fuelType` so the rest of the code can tell which
  // pipe/belt it belongs on.
  function compatibleFuels(dataset, machine) {
    if (!machine || !dataset) return [];

    // fluid-burning machine: the fluidbox filter, if any, pins it to one fluid
    const fluidFuel = machine.fluid_fuel;
    if (fluidFuel) {
      const fluids = Object.values(dataset.fluids || {});
      const burnable = fluidFuel.filter
        ? fluids.filter((f) => f.name === fluidFuel.filter)
        : fluids.filter((f) => f.fuel_value > 0);
      return burnable.map((f) => ({ ...f, _fuelType: "fluid" }));
    }

    const cats = asArray(machine.fuel_categories);
    if (!cats.length) return [];
    return Object.values(dataset.items || {})
      .filter((it) => it.fuel_category && cats.includes(it.fuel_category) && it.fuel_value)
      .map((it) => ({ ...it, _fuelType: "item" }));
  }

  function fuelKind(machine) {
    return machine && machine.fluid_fuel ? "fluid" : "item";
  }

  // The chosen fuel's prototype entry, whichever table it lives in.
  function fuelEntry(dataset, machine, fuelName) {
    if (!dataset || !machine || !fuelName) return null;
    const table = fuelKind(machine) === "fluid" ? dataset.fluids : dataset.items;
    const entry = (table || {})[fuelName];
    return entry ? { ...entry, _fuelType: fuelKind(machine) } : null;
  }

  // item:coal  /  fluid:natural-gas - so the fuel lands on the right belt or pipe
  function fuelKey(machine, fuelName) {
    if (!fuelName) return null;
    return itemKey(fuelKind(machine), fuelName);
  }

  function fuelConsumptionPerMachine(machine, fuel, consumptionBonus) {
    if (!machine || !fuel) return 0;
    const ff = machine.fluid_fuel;
    // A fluid machine with a FIXED draw (bob-steam-inserter and friends:
    // scale_fluid_usage = false + fluid_usage_per_tick) burns a constant amount
    // of fluid per tick while it works. That amount does not depend on the
    // fuel's energy value at all - and steam has fuel_value 0 in the dump, so
    // the old "energy / fuel_value" path returned exactly 0 and the steam
    // demand never showed up on any pipe.
    if (ff && ff.scale_fluid_usage === false) {
      const perTick = ff.fluid_usage_per_tick || 0;
      if (perTick > 0) return perTick * 60; // units/sec per machine
    }
    if (!fuel.fuel_value) return 0;
    // Factorio floors the energy-consumption multiplier at 20% (that's why a
    // furnace stuffed with efficiency modules never drops below 20% fuel burn).
    const effectiveUsage = (machine.energy_usage || 0) * Math.max(MIN_CONSUMPTION_MULT, 1 + (consumptionBonus || 0));
    // A fluid energy source wastes part of the fuel's energy (effectivity < 1),
    // so it burns MORE fluid than the raw Joules would suggest.
    const rawEffectivity = ff && typeof ff.effectivity === "number" ? ff.effectivity : 1;
    const effectivity = rawEffectivity > 0 ? rawEffectivity : 1;
    return effectiveUsage / (fuel.fuel_value * effectivity); // units/sec per machine
  }

  // =========================================================================
  // MODULES
  // =========================================================================
  //
  // Modules are picked BY TYPE (speed / productivity / efficiency / quality /
  // whatever a mod invents), never by hardcoded item name - the whole point is
  // that Space Age adds quality modules and other mods add their own tiers, and
  // none of that is known here in advance. So:
  //
  //   1. every module-looking item in the dataset is classified into a type
  //      (from the dump's own module_category if the mod exports it, otherwise
  //      from its internal/display name);
  //   2. its bonuses come from the dump (module_effects) if present, else from
  //      the vanilla table below, else from what YOU typed in ("свои значения",
  //      stored per dataset in localStorage) - so a mod module with unknown
  //      numbers is still fully usable;
  //   3. if a type isn't in the dataset at all (old dump without quality
  //      modules), we still offer it as a virtual module so the math works.
  //
  // A node holds `modules: [{name, count}]` plus `manualEffects` (the old
  // hand-typed %-fields, now meaning "beacons / anything we don't model").
  // `node.effects` is always the COMPUTED TOTAL of both - which is what the
  // solver and every belt/fuel calculation already read.

  const MIN_CONSUMPTION_MULT = 0.2; // Factorio's hard floor on energy usage

  // Vanilla bonuses per tier (index 0 = tier 1). Used when the dump doesn't
  // carry real numbers. Tiers above the table reuse the last known tier.
  const MODULE_TYPES = [
    {
      id: "speed",
      label: "Скорость",
      short: "скор",
      match: /speed|скорост/i,
      tiers: [
        { speed: 0.2, consumption: 0.5 },
        { speed: 0.3, consumption: 0.6 },
        { speed: 0.5, consumption: 0.7 },
      ],
    },
    {
      id: "productivity",
      label: "Продуктивность",
      short: "прод",
      match: /productivity|продуктивн/i,
      tiers: [
        { productivity: 0.04, speed: -0.05, consumption: 0.4 },
        { productivity: 0.06, speed: -0.1, consumption: 0.6 },
        { productivity: 0.1, speed: -0.15, consumption: 0.8 },
      ],
    },
    {
      id: "efficiency",
      label: "Эффективность",
      short: "эфф",
      match: /efficiency|effectivity|эффективн/i,
      tiers: [{ consumption: -0.3 }, { consumption: -0.4 }, { consumption: -0.5 }],
    },
    {
      id: "quality",
      label: "Качество",
      short: "кач",
      match: /quality|качеств/i,
      tiers: [
        { quality: 0.01, speed: -0.05 },
        { quality: 0.015, speed: -0.05 },
        { quality: 0.025, speed: -0.05 },
      ],
    },
  ];

  // pollution is display-only (we don't model pollution yet), but Pyanodon has
  // modules whose ONLY effect is pollution - showing "нет бонусов" for those would
  // be a lie.
  const MODULE_EFFECT_KEYS = ["speed", "productivity", "consumption", "quality", "pollution"];
  // Every key here needs a label - "pollution" was added to the list above and
  // showed up in the effects editor as a field literally called "undefined".
  const MODULE_EFFECT_LABELS = { speed: "скор", productivity: "прод", consumption: "энерг", quality: "кач", pollution: "загр" };

  function moduleTypeById(id) {
    return MODULE_TYPES.find((t) => t.id === id) || { id, label: prettify(id), short: id, tiers: [] };
  }

  // ---- per-dataset user overrides for module bonuses (mods we can't know) ----

  function moduleOverridesKey() {
    return `chaincalc_module_fx_${state.datasetId || "none"}`;
  }

  function loadModuleOverrides() {
    try {
      return JSON.parse(localStorage.getItem(moduleOverridesKey()) || "{}") || {};
    } catch (e) {
      return {};
    }
  }

  function saveModuleOverride(moduleName, effects) {
    const all = loadModuleOverrides();
    all[moduleName] = effects;
    try {
      localStorage.setItem(moduleOverridesKey(), JSON.stringify(all));
    } catch (e) {
      /* private mode / quota - overrides just won't persist */
    }
    moduleCatalogCache = null;
  }

  // ---- catalog ----

  let moduleCatalogCache = null; // rebuilt whenever the dataset changes

  function looksLikeModule(item) {
    if (!item) return false;
    // dump_version >= 2 carries the real prototype type, so no guessing: an item
    // is a module iff the game says it is. The name heuristics below are only
    // for older dumps (and they misfire both ways - Pyanodon has non-module items
    // with "модуль" in the name, and modded modules named without "module").
    if (item.prototype_type) return item.prototype_type === "module";
    if (item.module_category || item.module_effects || item.module_effect) return true;
    return /module/i.test(item.name || "") || /модул/i.test(item.display_name || "");
  }

  function classifyModuleType(item) {
    const explicit = (item.module_category || "").toLowerCase();
    if (explicit) {
      const known = MODULE_TYPES.find((t) => t.match.test(explicit) || t.id === explicit);
      if (known) return known.id;
      return explicit; // an unknown mod category stays its own type - by design
    }
    const hay = `${item.name || ""} ${item.display_name || ""}`;
    const known = MODULE_TYPES.find((t) => t.match.test(hay));
    return known ? known.id : "other";
  }

  function moduleTier(item) {
    if (item.tier) return item.tier;
    const m = String(item.name || "").match(/(\d+)\s*$/) || String(item.display_name || "").match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : 1;
  }

  function defaultEffectsFor(typeId, tier) {
    const type = MODULE_TYPES.find((t) => t.id === typeId);
    if (!type || !type.tiers.length) return {};
    const idx = Math.min(Math.max(1, tier), type.tiers.length) - 1;
    return { ...type.tiers[idx] };
  }

  function normalizeEffects(raw) {
    const out = {};
    for (const k of MODULE_EFFECT_KEYS) {
      const v = raw && raw[k];
      if (typeof v === "number" && isFinite(v)) out[k] = v;
    }
    // A dump may name it "energy"/"pollution" instead of "consumption".
    if (out.consumption === undefined && raw && typeof raw.energy === "number") out.consumption = raw.energy;
    return out;
  }

  function buildModuleCatalog() {
    if (moduleCatalogCache) return moduleCatalogCache;
    const dataset = state.dataset;
    const overrides = loadModuleOverrides();
    const list = [];
    const seenTypes = new Set();

    for (const item of Object.values((dataset && dataset.items) || {})) {
      if (!looksLikeModule(item)) continue;
      const typeId = classifyModuleType(item);
      const tier = moduleTier(item);
      const dumped = normalizeEffects(item.module_effects || item.module_effect);
      const hasDumped = Object.keys(dumped).length > 0;
      const custom = overrides[item.name];
      list.push({
        name: item.name,
        label: item.display_name || prettify(item.name),
        typeId,
        tier,
        icon: item.icon_url,
        virtual: false,
        source: custom ? "custom" : hasDumped ? "dump" : Object.keys(defaultEffectsFor(typeId, tier)).length ? "default" : "unknown",
        effects: normalizeEffects(custom || (hasDumped ? dumped : defaultEffectsFor(typeId, tier))),
      });
      seenTypes.add(typeId);
    }

    // A type the dataset knows nothing about (classic case: an old dump made
    // before Space Age, so no quality modules) is still offered - as a virtual
    // module you can retune. Better than pretending the module doesn't exist.
    for (const type of MODULE_TYPES) {
      if (seenTypes.has(type.id)) continue;
      type.tiers.forEach((_, i) => {
        const name = `virtual:${type.id}-${i + 1}`;
        const custom = overrides[name];
        list.push({
          name,
          label: `Модуль «${type.label.toLowerCase()}» ${i + 1}`,
          typeId: type.id,
          tier: i + 1,
          icon: null,
          virtual: true,
          source: custom ? "custom" : "default",
          effects: normalizeEffects(custom || defaultEffectsFor(type.id, i + 1)),
        });
      });
    }

    list.sort((a, b) => a.typeId.localeCompare(b.typeId) || a.tier - b.tier || a.label.localeCompare(b.label));
    moduleCatalogCache = list;
    return list;
  }

  function moduleDef(name) {
    return buildModuleCatalog().find((m) => m.name === name) || null;
  }

  const STANDARD_TYPE_ORDER = MODULE_TYPES.map((t) => t.id);

  function moduleCatalogByType() {
    const groups = new Map();
    for (const m of buildModuleCatalog()) {
      if (!groups.has(m.typeId)) groups.set(m.typeId, []);
      groups.get(m.typeId).push(m);
    }
    // Standard four first, then whatever the modpack invented, alphabetically.
    // Pyanodon has ~60 categories (TURD modules, creature modules) - without an
    // order they'd land in hash order, which is chaos.
    return new Map(
      [...groups.entries()].sort((a, b) => {
        const ia = STANDARD_TYPE_ORDER.indexOf(a[0]);
        const ib = STANDARD_TYPE_ORDER.indexOf(b[0]);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        return a[0].localeCompare(b[0]);
      })
    );
  }

  // ---- какой модуль влезает в завод ---------------------------------------
  //
  // Pyanodon задаёт список категорий модулей явно для каждой постройки
  // (pyalienlife/prototypes/module-restrictions.lua: allowed_module_categories), и игра
  // его соблюдает: в лабораторию прандиум влезает только «Породистый хлопкоед».
  //
  // Пустой список — дамп про категории ничего не сказал (49 машин из 769): тогда ничего
  // не запрещается.
  function machineModuleCategories(machine) {
    return asArray(machine && machine.allowed_module_categories);
  }

  function machineModuleCatsText(machine) {
    return machineModuleCategories(machine)
      .map((c) => `«${moduleCategoryLabel(c)}»`)
      .join(", ");
  }

  /** Как назвать категорию модуля: обычные четыре — по-русски, модовые — как записаны в дампе. */
  function moduleCategoryLabel(cat) {
    return STANDARD_TYPE_ORDER.includes(cat) ? moduleTypeById(cat).label.toLowerCase() : cat;
  }

  /** Влезает ли этот модуль в этот завод (и почему нет).
   *
   *  Две проверки по правилам игры:
   *   1) категория модуля должна быть в allowed_module_categories завода;
   *   2) продуктивность не влезает в маяк и в рецепт, который её не принимает.
   */
  function moduleFitsMachine(moduleName, machine, recipe) {
    const def = typeof moduleName === "string" ? moduleDef(moduleName) : moduleName;
    if (!def || !machine) return { ok: true, reason: null, unknown: true };
    if (def.typeId === "productivity") {
      if (machine.type === "beacon") return { ok: false, unknown: false, reason: "маяк не передаёт продуктивность" };
      if (recipe && recipe.allow_productivity === false) {
        return { ok: false, unknown: false, reason: "рецепт не принимает продуктивность" };
      }
    }
    if (def.virtual) return { ok: true, reason: null, unknown: true };
    const cats = machineModuleCategories(machine);
    if (!cats.length) return { ok: true, reason: null, unknown: true };
    if (cats.includes(def.typeId)) return { ok: true, reason: null, unknown: false };
    return {
      ok: false,
      unknown: false,
      reason: `${machineDisplayName(machine)} принимает только ${machineModuleCatsText(machine)}`,
    };
  }

  /** Семья модуля: «cottongut-mk02» → «cottongut», «speed-module-2» → «speed-module».
   *
   *  Нужна, чтобы по клику на значок предложить версии выше: игра считает
   *  МК1…МК4 одним модулем разных уровней, а в дампе это разные предметы.
   */
  function moduleFamily(name) {
    return String(name || "")
      .replace(/[-_]mk0?(\d+)$/i, "")
      .replace(/[-_](\d+)$/i, "");
  }

  /** Все версии того же модуля (МК1…МК4), от младшей к старшей. */
  function moduleVariants(name) {
    const def = moduleDef(name);
    if (!def) return [];
    const fam = moduleFamily(def.name);
    return buildModuleCatalog()
      .filter((m) => m.typeId === def.typeId && moduleFamily(m.name) === fam)
      .sort((a, b) => a.tier - b.tier || a.label.localeCompare(b.label));
  }

  /** Модуль, которым завод работает «по умолчанию», и сколько их влезает.
   *
   *  Пианодон сам объявляет это для каждой фермы
   *  (pyalienlife/scripts/farming/farm-building-list.lua): prandium-lab →
   *  cottongut-mk01, moondrop-greenhouse → moondrop, wpu-turd →
   *  py-sawblade-module-mk01. В дампе поля нет, но правило выводится
   *  однозначно: категория модуля совпадает с категорией рецепта (или у завода
   *  она единственная), а внутри семьи берётся младшая версия. Сверено со всеми
   *  фермами мода — совпадает с их default_module.
   */
  function recipeDefaultModule(machine, recipe) {
    const cats = machineModuleCategories(machine);
    if (!cats.length) return null;
    const recipeCat = recipe && recipe.category;
    const cat = recipeCat && cats.includes(recipeCat) ? recipeCat : cats.length === 1 ? cats[0] : null;
    if (!cat) return null;
    // «Модуль, без которого рецепт не работает» бывает только у модовых
    // категорий (породы, растения, пильные диски). Обычные скорость/эффективность
    // никому не обязательны — их калькулятор не навязывает.
    if (STANDARD_TYPE_ORDER.includes(cat)) return null;
    const mods = buildModuleCatalog().filter((m) => m.typeId === cat && !m.virtual);
    if (!mods.length) return null;
    const own = mods.filter((m) => moduleFamily(m.name) === cat);
    const pool = own.length ? own : mods;
    return pool.slice().sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))[0];
  }

  /** Подставить нужный рецепту модуль, если у завода пусто.
   *
   *  Ставим СРАЗУ максимум слотов (так эта машина и работает в игре: 20 слотов —
   *  20 «Породистых хлопкоедов»). Если человек снял модули сам, второй раз не
   *  навязываемся: помним, для какой пары «рецепт@завод» уже подставляли.
   */
  function autoFillRecipeModules(node, machine, recipe) {
    const slots = machineModuleSlots(machine);
    if (!node || !slots) return false;
    const key = `${node.recipeName}@${node.machineName}`;
    if (asArray(node.modules).filter((m) => m && m.name).length) return false;
    if (node.autoModulesFor === key) return false;
    const def = recipeDefaultModule(machine, recipe);
    if (!def) return false;
    node.modules = [{ name: def.name, count: slots }];
    node.autoModulesFor = key;
    return true;
  }

  /** Сколько модулей уже стоит в этом «хозяине» (завод или строка маяка). */
  function hostModuleCount(node, target) {
    const list = moduleListFor(node, target) || [];
    return list.reduce((s, m) => s + Math.max(0, Math.floor(m.count || 0)), 0);
  }

  /** Сколько ставить при ручном добавлении: свободные слоты, а если места нет — 0.
   *
   *  Модуль занимает все свободные слоты (у лаборатории 20 слотов под хлопкоедов), второй
   *  получает остаток; повторное добавление того же модуля добивает его до максимума.
   *  Если число слотов неизвестно — +1.
   */
  function moduleCountToAdd(node, machine, moduleName, target) {
    const slots = machineModuleSlots(machine);
    const list = moduleListFor(node, target) || [];
    const existing = list.find((m) => m.name === moduleName);
    if (slots == null) return existing ? Math.max(1, Math.floor(existing.count || 0) + 1) : 1;
    const own = existing ? Math.max(0, Math.floor(existing.count || 0)) : 0;
    return Math.max(0, slots - (hostModuleCount(node, target) - own));
  }

  function machineModuleSlots(machine) {
    // Only known if the dump exports it; null means "we don't know, don't pretend
    // to enforce a limit".
    if (!machine) return null;
    const v = machine.module_slots ?? machine.module_inventory_size;
    return typeof v === "number" ? v : null;
  }

  // Does this module type SUIT this machine+recipe?
  //
  // The dump answers this for real, so we now trust it: `allowed_module_categories`
  // is what the game enforces. Pyanodon sets it explicitly per farm
  // (module-restrictions.lua), and the laboratory that breeds хлопкоеды accepts
  // ONLY the «cottongut» category - an ordinary speed module is refused by the
  // game, so allowing it here was a lie the user could not work around.
  //
  // History: this used to treat the list as "a hint, not a filter", because the
  // sawmill (wpu-*-turd) was said to take ordinary modules anyway. The mod source
  // says otherwise - it sets allowed_module_categories = {"sawblade"} for exactly
  // that building - so the strict reading is the correct one. Machines whose dump
  // entry has NO list stay permissive: we don't know, so we don't forbid.
  function moduleTypeFitness(typeId, machine, recipe) {
    // Productivity really is refused by these two, and both are checkable:
    //   * a recipe with maximum_productivity == 0 (the solver zeroes it anyway);
    //   * a beacon - beacons cannot transmit productivity, that's a game rule.
    if (typeId === "productivity") {
      if (recipe && recipe.allow_productivity === false) {
        return { suits: false, reason: "рецепт не принимает продуктивность" };
      }
      if (machine && machine.type === "beacon") {
        return { suits: false, reason: "маяк не передаёт продуктивность" };
      }
    }

    const machineCats = machineModuleCategories(machine);
    if (machineCats.length) {
      return machineCats.includes(typeId)
        ? { suits: true, reason: null }
        : { suits: false, reason: `${machineDisplayName(machine)} принимает только ${machineModuleCatsText(machine)}` };
    }

    // Дамп про категории молчит (49 машин из 769) — не мешаем ставить обычные.
    if (STANDARD_TYPE_ORDER.includes(typeId)) return { suits: true, reason: null };
    return { suits: false, reason: `${machineDisplayName(machine)}: дамп не говорит, какие модули он принимает` };
  }

  // What the dump literally said - so a wrong recommendation can be diagnosed
  // instead of guessed at.
  function moduleRulesEvidence(machine, recipe) {
    const effects = asArray(machine && machine.allowed_effects);
    const cats = machineModuleCategories(machine);
    const parts = [
      `дамп: категории ${cats.length ? cats.join(", ") : "не указаны (принимаем обычные)"}`,
      // shown for diagnosis only - measured NOT to block insertion (see
      // moduleTypeFitness), so it never hides anything
      `эффекты ${effects.length ? effects.join(", ") : "любые"} (справочно)`,
    ];
    if (recipe && recipe.allow_productivity === false) parts.push("рецепт без продуктивности");
    return parts.join(" · ");
  }

  // The machine's own built-in bonus (Space Age: Electromagnetic plant is +50%
  // productivity with no modules at all). The BACKEND adds this to the node's
  // effects when solving, so we never fold it into node.effects here - that would
  // count it twice. We only show it, and mirror it in the local fuel estimate.
  function machineBaseEffect(machine) {
    const base = machine && machine.base_effect;
    return base && typeof base === "object" ? base : null;
  }

  function effectsWithMachineBase(node, machine) {
    const base = machineBaseEffect(machine);
    const eff = { ...(node.effects || {}) };
    if (base) for (const k of MODULE_EFFECT_KEYS) if (base[k]) eff[k] = (eff[k] || 0) + base[k];
    return eff;
  }

  // =========================================================================
  // BEACONS
  // =========================================================================
  //
  // В Factorio 2.0 передача маяка не плоские 50%: чем больше маяков достаёт до одной
  // машины, тем меньше доля. Кривая — массив `profile` в дампе (у ванили и Py):
  //
  //   effect = N × distribution_effectivity × profile[N] × Σ(модули ОДНОГО маяка)
  //
  // Пример (маяк Py): effectivity 0.2, profile [1, 0.707, 0.577, 0.5, ...] (1/√N);
  // два маяка передают 2 × 0.2 × 0.707 = 28% эффекта модулей, а не 40%.
  //
  // Модель: маяки описываются строками, строка — один маяк:
  //
  //   node.beacons = [{ name, modules: [{name, count}], covers }]
  //
  //   name    — постройка-маяк;
  //   modules — что вставлено в этот маяк;
  //   covers  — сколько заводов этапа он накрывает (null = все заводы этапа).
  //
  // Следствия:
  //   * маяков на этапе ровно столько, сколько строк;
  //   * пока маяков хватает на разные части этапа, каждый завод накрыт одним маяком, а
  //     заводы вне покрытия работают без прибавки; «покрывает заводов» поэтому меняет и
  //     число заводов;
  //   * когда покрытия больше, чем заводов, лишние маяки ложатся вторым-третьим слоем,
  //     и до завода достаёт несколько маяков: тут работает падение profile[N];
  //   * ceil(заводов / покрытие) — подсказка, сколько таких маяков нужно на весь этап;
  //   * эффект считается средним по этапу: заводы без маяка дают ноль, поэтому при
  //     частичном покрытии прибавка на этап меньше, чем у одного завода.

  function datasetBeacons(dataset) {
    return Object.values((dataset && dataset.entities) || {}).filter((e) => e.type === "beacon");
  }

  /** Какая доля модулей ОДНОГО маяка доходит до завода, когда до него достаёт
   *  `count` маяков: effectivity × profile[count]. Это вклад каждого маяка. */
  function beaconSharePerBeacon(beacon, count) {
    if (!beacon || count <= 0) return 0;
    const effectivity = beacon.distribution_effectivity ?? 0.5;
    const profile = asArray(beacon.profile);
    // profile is indexed by the number of beacons (1-based in Lua). Past the end
    // of the array the last value holds.
    const factor = profile.length ? profile[Math.min(count, profile.length) - 1] : 1;
    return effectivity * factor;
  }

  /** Сколько модулей доходит до завода от всех `count` маяков сразу (их сумма).
   *
   *  Например, 3 маяка с effectivity 0.2 дают 3 × 0.2 × profile[3] ≈ 34.6% от суммы
   *  модулей в этих маяках.
   */
  function beaconTransmission(beacon, count) {
    if (!beacon || count <= 0) return 0;
    return count * beaconSharePerBeacon(beacon, count);
  }

  /** Старые цепочки хранили node.beacon = {name, count, modules}.
   *
   *  `count` там означал «сколько маяков достаёт до завода», то есть ровно число
   *  слоёв: превращаем его в столько же строк, каждая накрывает все заводы. Числа
   *  после такого переноса те же самые, поэтому старая цепочка не «поедет».
   */
  function migrateNodeBeacons(node) {
    const old = node.beacon;
    const rows = [];
    if (old && old.name && old.count > 0) {
      const layers = Math.max(1, Math.floor(old.count));
      for (let i = 0; i < layers; i += 1) {
        rows.push({
          name: old.name,
          covers: null,
          modules: asArray(old.modules).map((m) => ({ name: m.name, count: Math.max(0, Math.floor(m.count || 0)) })),
        });
      }
    }
    delete node.beacon;
    return rows;
  }

  /** Строки маяков этапа (и перенос старого формата при первом обращении).
   *
   *  ВАЖНО: список модулей правим НА МЕСТЕ, а не подменяем новым массивом.
   *  Ссылку на него держит открытое окно выбора модулей: оно делает
   *  `moduleListFor(...)` → `moduleCountToAdd(...)` (а тот внутри спрашивает
   *  строки заново) → `push`. Если на каждом обращении отдавать новый массив,
   *  push уходит в «отцепленный» и модуль в маяк не добавляется.
   */
  function beaconRows(node) {
    if (!node) return [];
    if (!Array.isArray(node.beacons)) node.beacons = migrateNodeBeacons(node);
    for (const row of node.beacons) {
      if (!Array.isArray(row.modules)) {
        row.modules = asArray(row.modules);
        continue;
      }
      for (let i = row.modules.length - 1; i >= 0; i -= 1) {
        const inst = row.modules[i];
        if (!inst || !inst.name) row.modules.splice(i, 1);
      }
    }
    return node.beacons;
  }

  /** Строка маяка живёт только вместе со своими модулями: «beacon:2». */
  function beaconTarget(index) {
    return `beacon:${Math.max(0, Math.floor(index || 0))}`;
  }

  function parseBeaconTarget(target) {
    const m = /^beacon:(\d+)$/.exec(String(target == null ? "" : target));
    return m ? Number(m[1]) : null;
  }

  function isBeaconTarget(target) {
    return parseBeaconTarget(target) != null;
  }

  /** Какие модули лежат в этом «хозяине»: завод или конкретная строка маяка. */
  function moduleListFor(node, target) {
    if (!node) return null;
    if (!isBeaconTarget(target)) {
      if (!Array.isArray(node.modules)) node.modules = [];
      return node.modules;
    }
    const index = parseBeaconTarget(target);
    const row = beaconRows(node)[index];
    if (!row) return null;
    // Массив не подменяем: в него пишет окно выбора модулей (см. beaconRows).
    if (!Array.isArray(row.modules)) row.modules = asArray(row.modules);
    return row.modules;
  }

  /** Маяк этой строки (постройка) или null, если строки/маяка нет. */
  function beaconOfRow(row) {
    if (!row || !row.name) return null;
    return (state.dataset && state.dataset.entities && state.dataset.entities[row.name]) || null;
  }

  /** Сколько заводов этапа накрывает ОДИН маяк этой строки.
   *
   *  Пусто в поле «покрывает заводов» = весь этап. Больше, чем заводов, быть не
   *  может: маяк физически не накроет двадцать пятый завод, если их двадцать.
   */
  function beaconCapacity(row, machines) {
    if (!machines) return 0;
    const covers = Number(row && row.covers);
    return Math.max(0, Math.min(covers > 0 ? Math.floor(covers) : machines, machines));
  }

  /** Заводов у этапа — столько, сколько построено (целых). */
  function machinesOfNode(node) {
    const res = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[node.id];
    const machines = res && (res.machinesCeil || res.machines);
    return machines ? Math.max(0, Math.floor(machines)) : 0;
  }

  /** Сколько таких маяков НУЖНО, чтобы накрыть весь этап: ceil(заводов / покрытие).
   *
   *  Это подсказка, а не заказ: построено будет столько маяков, сколько строк.
   */
  function beaconsForRow(node, row) {
    const machines = machinesOfNode(node);
    if (!machines) return 0;
    const per = beaconCapacity(row, machines);
    if (!per) return 0;
    return Math.max(1, Math.ceil(machines / per));
  }

  /** Покрытие этапа маяками: кто накрыт, кто нет и сколько маяков до завода.
   *
   *  Маяки ставятся по своим частям этапа, поэтому «мест под маяк» всего
   *  `capacity`, и они размазываются по заводам по порядку строк. Пока мест не
   *  больше, чем заводов, каждый накрытый завод получает ОДИН маяк, а остальные
   *  заводы не получают ничего. Когда мест больше, лишние ложатся вторым-третьим
   *  слоем: `base` маяков до завода, а `extra` заводов получают на один больше.
   */
  function beaconCoverage(node) {
    const rows = beaconRows(node).filter((row) => row && row.name);
    const machines = machinesOfNode(node);
    const caps = rows.map((row) => beaconCapacity(row, machines));
    const capacity = caps.reduce((sum, cap) => sum + cap, 0);
    const covered = Math.min(machines, capacity);
    const base = machines ? Math.floor(capacity / machines) : 0;
    const extra = machines ? capacity - base * machines : 0;
    return {
      rows,
      caps,
      capacity,
      covered,
      uncovered: Math.max(0, machines - covered),
      machines,
      base,
      extra,
      // Сколько маяков нужно, чтобы накрыть весь этап (подсказка по каждой строке).
      needed: caps.map((cap) => (cap && machines ? Math.ceil(machines / cap) : 0)),
      // Пока этап не посчитан, заводов не знаем: считаем, что маяки накрывают
      // весь этап (иначе первый расчёт ушёл бы без эффекта маяков вовсе).
      assumedWholeStage: !machines,
    };
  }

  /** Сколько маяков достаёт до одного завода: от `min` до `max`.
   *
   *  Пока маяков меньше, чем заводов, до завода достаёт максимум один; «слои» появляются,
   *  когда маяков больше, чем заводов.
   */
  function beaconLayersRange(node) {
    const cov = beaconCoverage(node);
    if (cov.assumedWholeStage) {
      return { min: cov.rows.length, max: cov.rows.length };
    }
    return { min: cov.base, max: cov.base + (cov.extra ? 1 : 0) };
  }

  /** Сколько маяков достаёт до завода (по максимуму) — для подписей. */
  function beaconLayers(node) {
    return beaconLayersRange(node).max;
  }

  /** Какие заводы (по номерам от 1) накрывает маяк этой строки.
   *
   *  Маяки размазаны по этапу по порядку строк: первая строка занимает первые
   *  `cap` заводов, вторая — следующие и так далее, по кругу (когда маяков
   *  больше, чем заводов, круг замыкается и начинается второй слой).
   */
  function beaconRowMachines(node, index) {
    const cov = beaconCoverage(node);
    const cap = cov.caps[index] || 0;
    if (!cov.machines || !cap) return [];
    let start = 0;
    for (let i = 0; i < index; i += 1) start += cov.caps[i] || 0;
    const out = [];
    for (let slot = start; slot < start + cap; slot += 1) {
      out.push((slot % cov.machines) + 1);
    }
    return out;
  }

  /** Эффект маяков этапа: СРЕДНЕЕ по всем заводам (заводы без маяка дают ноль).
   *
   *  Каждый завод считает свою прибавку от тех маяков, что до него достают:
   *  вклад маяка = effectivity × profile[число маяков у ЭТОГО завода] × модули.
   *  Дальше усредняем по этапу — именно среднее и уезжает в расчёт, потому что
   *  решатель считает этап одним числом.
   */
  function beaconEffects(node) {
    const rows = beaconRows(node).filter((row) => row && row.name);
    if (!rows.length) return null;
    const out = {};
    for (const k of MODULE_EFFECT_KEYS) out[k] = 0;
    const cov = beaconCoverage(node);
    if (!cov.machines) {
      // Этап ещё не посчитан: считаем, что маяки накрывают весь этап, и берём
      // вклад одного маяка за слой — иначе первый расчёт ушёл бы без маяков.
      const layers = Math.max(1, rows.length);
      for (const row of rows) {
        const beacon = beaconOfRow(row);
        if (!beacon) continue;
        const share = beaconSharePerBeacon(beacon, layers);
        for (const inst of row.modules || []) {
          const def = moduleDef(inst.name);
          if (!def) continue;
          const count = Math.max(0, Math.floor(inst.count || 0));
          for (const k of MODULE_EFFECT_KEYS) out[k] += (def.effects[k] || 0) * count * share;
        }
      }
      return out;
    }
    // Каждый завод накрыт `base` маяками, а первые `extra` заводов — на один
    // больше (так места размазываются по этапу, когда маяков больше, чем заводов).
    for (let index = 0; index < rows.length; index += 1) {
      const beacon = beaconOfRow(rows[index]);
      const coveredByThisRow = beaconRowMachines(node, index);
      if (!beacon || !coveredByThisRow.length) continue;
      // Один и тот же маяк может стоять на заводах с разным числом маяков (base
      // и base + 1) — считаем сумму вкладов и делим на число заводов этапа.
      let sum = 0;
      for (const machine of coveredByThisRow) {
        const layers = cov.base + (machine <= cov.extra ? 1 : 0);
        sum += beaconSharePerBeacon(beacon, layers);
      }
      const average = sum / cov.machines;
      for (const inst of rows[index].modules || []) {
        const def = moduleDef(inst.name);
        if (!def) continue;
        const count = Math.max(0, Math.floor(inst.count || 0));
        for (const k of MODULE_EFFECT_KEYS) out[k] += (def.effects[k] || 0) * count * average;
      }
    }
    return out;
  }

  /** Всего маяков на этапе (это ровно число строк) и что с покрытием. */
  function beaconPlanForNode(node) {
    const cov = beaconCoverage(node);
    // Построено будет по одному маяку на строку: строка и есть маяк.
    const perRow = cov.rows.map(() => 1);
    return {
      rows: cov.rows.length,
      perRow,
      total: perRow.reduce((sum, n) => sum + n, 0),
      machines: cov.machines,
      covered: cov.covered,
      uncovered: cov.uncovered,
      // Сколько маяков нужно, чтобы накрыть весь этап (подсказка по строкам).
      needed: cov.needed,
      layers: beaconLayersRange(node),
    };
  }

  /** Зона снабжения маяка в тайлах — из дампа; null, если её там нет. */
  function beaconSupplyArea(beacon) {
    const supply = Number(beacon && beacon.supply_area_distance);
    if (!supply || supply <= 0) return null;
    return Math.round(2 * supply + 1);
  }

  /** Что человек ввёл в поле «покрывает заводов»: число или «весь этап» (null).
   *
   *  Пусто, ноль, мусор и минус — это всё «маяк достаёт до всего этапа»: так
   *  безопаснее, чем молча превратить опечатку в «один завод».
   */
  function parseCoversInput(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return null;
    const value = parseInt(text, 10);
    return isFinite(value) && value > 0 ? value : null;
  }

  function ensureNodeBeacon(node) {
    // Старое имя оставлено: по нему модули ищут «хозяина» (см. moduleListFor).
    if (!Array.isArray(node.beacons)) node.beacons = migrateNodeBeacons(node);
    return node.beacons;
  }

  // ---- node effects = manual + machine modules + beacons ----

  function ensureNodeEffects(node) {
    if (!node) return node;
    if (!node.manualEffects) {
      // Legacy chain: everything that was in .effects was typed by hand.
      const e = node.effects || {};
      node.manualEffects = {
        speed: e.speed || 0,
        productivity: e.productivity || 0,
        consumption: e.consumption || 0,
      };
    }
    node.modules = asArray(node.modules).filter((m) => m && m.name);
    beaconRows(node);       // строки маяков (+ перенос старого формата node.beacon)
    // Модуль, которым эта машина работает: у лаборатории прандиум — «Породистый
    // хлопкоед» × все слоты, у теплицы лунных капель — «Лунная капля» и т.д.
    // Ставится один раз на пару «рецепт@завод» и только если слотов ещё пусто.
    const machine = (state.dataset && state.dataset.entities) || {};
    const recipes = (state.dataset && state.dataset.recipes) || {};
    autoFillRecipeModules(node, machine[node.machineName], recipes[node.recipeName]);
    ensureNodeFuel(node);
    recomputeNodeEffects(node);
    return node;
  }

  function recomputeNodeEffects(node) {
    const man = node.manualEffects || {};
    const recipe = (state.dataset && state.dataset.recipes[node.recipeName]) || null;
    // Every key in MODULE_EFFECT_KEYS must start at 0 - the accumulation loop
    // below does `total[k] += ...`, and a missing key would turn into NaN and
    // poison the whole node.
    const total = {};
    for (const k of MODULE_EFFECT_KEYS) total[k] = 0;
    total.speed = man.speed || 0;
    total.productivity = man.productivity || 0;
    total.consumption = man.consumption || 0;
    for (const inst of node.modules || []) {
      const def = moduleDef(inst.name);
      if (!def) continue;
      const count = Math.max(0, Math.floor(inst.count || 0));
      if (!count) continue;
      for (const k of MODULE_EFFECT_KEYS) total[k] += (def.effects[k] || 0) * count;
    }
    const fromBeacons = beaconEffects(node);
    if (fromBeacons) for (const k of MODULE_EFFECT_KEYS) total[k] += fromBeacons[k] || 0;
    // The game caps productivity per recipe (vanilla: +300%); past that, extra
    // prod modules do nothing but eat power. Cap here so the number we show is
    // the number the solver (which caps too) actually used.
    const cap = recipe && recipe.maximum_productivity;
    if (typeof cap === "number" && cap >= 0) total.productivity = Math.min(total.productivity, cap);
    if (recipe && !recipe.allow_productivity) total.productivity = 0;
    node.effects = total;
    return total;
  }

  function walkTree(node, fn) {
    if (!node) return;
    fn(node);
    for (const child of Object.values(node.children || {})) walkTree(child, fn);
  }

  function ensureAllNodeEffects(root) {
    walkTree(root, ensureNodeEffects);
  }

  function moduleCountOnNode(node) {
    return (node.modules || []).reduce((s, m) => s + Math.max(0, Math.floor(m.count || 0)), 0);
  }

  function fmtPct(v) {
    const p = Math.round((v || 0) * 1000) / 10;
    return `${p > 0 ? "+" : ""}${p}%`;
  }

  function moduleEffectsSummary(effects) {
    const parts = [];
    if (effects.speed) parts.push(`${fmtPct(effects.speed)} скор`);
    if (effects.productivity) parts.push(`${fmtPct(effects.productivity)} прод`);
    if (effects.consumption) parts.push(`${fmtPct(effects.consumption)} энерг`);
    if (effects.quality) parts.push(`${fmtPct(effects.quality)} кач`);
    if (effects.pollution) parts.push(`${fmtPct(effects.pollution)} загр`);
    return parts.join(" · ") || "нет бонусов";
  }

  // ---------- error banner (surfaces JS exceptions instead of silently
  // doing nothing - this is what we were missing when a click "did nothing") ----------

  function showErrorBanner(message) {
    // «нужен вход по коду» — это не ошибка расчёта: окно входа уже показано.
    if (message === AUTH_MESSAGE) return;
    let banner = document.getElementById("jsErrorBanner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "jsErrorBanner";
      banner.style.cssText =
        "position:fixed;bottom:12px;right:12px;max-width:480px;background:#3a1414;border:1px solid #d9534f;color:#f3c9c7;padding:10px 14px;border-radius:6px;font-family:monospace;font-size:12px;z-index:9999;white-space:pre-wrap;";
      document.body.appendChild(banner);
    }
    banner.textContent = "Ошибка в интерфейсе: " + message + " (детали в консоли браузера, F12)";
    banner.style.display = "block";
    clearTimeout(banner._hideTimer);
    banner._hideTimer = setTimeout(() => (banner.style.display = "none"), 15000);
  }

  window.addEventListener("error", (e) => {
    console.error(e.error || e.message);
    showErrorBanner((e.error && e.error.message) || e.message);
  });

  function safeCall(fn) {
    // fn is very often an async function (recalcResults, applyFullBeltTarget,
    // recalcDescendantTabs, addTabForResource, group redistribution...). A
    // plain try { fn() } catch only ever catches a SYNCHRONOUS throw before
    // fn's first `await` - anything thrown after that point becomes an
    // unhandled promise rejection that this catch never sees. That let
    // failures partway through a multi-tab recalculation abort silently
    // (no error banner) and skip whatever cleanup/restore code came after
    // the throw, leaving `state` pointed at whatever tab was mid-processing.
    // Routing through a resolved promise lets .catch see BOTH sync throws
    // and async rejections.
    Promise.resolve()
      .then(fn)
      .catch((e) => {
        console.error(e);
        showErrorBanner(e.message);
      });
  }

  // ---------- dataset loading / API ----------

  // Кабинет: пока его нет, /api закрыт и страница показывает окно входа. Все
  // запросы идут через apiFetch — иначе после истечения сессии (неделя) страница
  // молча показывала бы пустые списки вместо «войди по коду».
  const AUTH_MESSAGE = "нужен вход по коду кабинета";

  async function apiFetch(url, options) {
    // X-Lang: the server translates what ends up inside generated blueprints (name, description)
    const lang = window.i18n ? window.i18n.lang() : "ru";
    const response = await fetch(url, { ...(options || {}), headers: { ...((options && options.headers) || {}), "X-Lang": lang } });
    if (response.status === 401) {
      let text = AUTH_MESSAGE;
      try {
        const data = await response.clone().json();
        if (data && data.error) text = data.error;
      } catch (e) {
        // тело не JSON — покажем общий текст
      }
      showLogin(text);
      throw new Error(AUTH_MESSAGE);
    }
    return response;
  }

  /** Кто в кабинете: спрашиваем у сервера при загрузке страницы. */
  async function fetchAccount() {
    try {
      const response = await fetch("/api/auth/me");
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      console.error("не смог спросить про кабинет:", e);
      return null;
    }
  }

  function accountChipText(me) {
    if (!me || !me.user) return "";
    const mask = me.user.codeMask ? ` · код ${me.user.codeMask}` : "";
    return `кабинет №${me.user.number}${mask}`;
  }

  // The server deletes a cabinet nobody signed in to for N days: tell the number everywhere the warning is.
  function renderInactiveWarning(me) {
    const days = me && typeof me.inactiveDays === "number" ? me.inactiveDays : 30;
    document.querySelectorAll(".inactiveDays").forEach((el) => { el.textContent = String(Math.round(days) || 30); });
    document.querySelectorAll(".inactiveWarn").forEach((el) => el.classList.toggle("hidden", days === 0));
  }

  function renderAccount(me) {
    state.account = me || null;
    renderInactiveWarning(me);
    const chip = document.getElementById("cabinetChip");
    if (chip) chip.textContent = accountChipText(me);
    const info = document.getElementById("cabinetInfo");
    if (info) {
      info.innerHTML = me && me.user
        ? `кабинет <b>№${me.user.number}</b> · код <b>${flowEscape(me.user.codeMask || "")}</b> · ` +
          `вход держится ${me.sessionDays} дн.`
        : "кабинета нет";
    }
    return state.account;
  }

  function setLoginError(message) {
    const box = document.getElementById("loginError");
    if (!box) return;
    box.textContent = message || "";
    box.classList.toggle("hidden", !message);
  }

  /** Показывает окно входа и прячет приложение: без кабинета работать не с чем. */
  function showLogin(message) {
    const view = document.getElementById("loginView");
    const appEl = document.getElementById("appShell");
    if (!view) return;
    if (message) setLoginError(message);
    view.classList.remove("hidden");
    if (appEl) appEl.classList.add("hidden");
    setLoginStep("choice");
  }

  function hideLogin() {
    const view = document.getElementById("loginView");
    const appEl = document.getElementById("appShell");
    if (view) view.classList.add("hidden");
    if (appEl) appEl.classList.remove("hidden");
    setLoginError("");
  }

  function setLoginStep(step) {
    const choice = document.getElementById("loginStepChoice");
    const code = document.getElementById("loginStepCode");
    if (choice) choice.classList.toggle("hidden", step !== "choice");
    if (code) code.classList.toggle("hidden", step !== "code");
  }

  function codeTextHTML(code) {
    return `<span class="codeValue">${flowEscape(code || "")}</span>`;
  }

  /** Код показывается один раз — даём его скопировать и скачать файлом.
   *
   * Заодно переключаем окно входа на шаг «вот твой код»: показать код и оставить
   * на экране кнопку «Войти по коду» было бы издевательством.
   */
  function showNewCode(code, note) {
    setLoginStep("code");
    const box = document.getElementById("newCodeBox");
    if (box) box.innerHTML = `${codeTextHTML(code)}${note ? `<p class="hint msg">${flowEscape(note)}</p>` : ""}`;
    const cabinetBox = document.getElementById("cabinetNewCode");
    if (cabinetBox) {
      cabinetBox.innerHTML =
        `<b>Новый код:</b>${codeTextHTML(code)}` +
        `<button class="btn btn-ghost" id="copyNewCodeBtn">Скопировать</button>` +
        `<p class="hint msg">Старый код больше не работает. Входы на других устройствах закрыты, этот — остался.</p>`;
      cabinetBox.classList.remove("hidden");
    }
    const copyBtn = document.getElementById("copyNewCodeBtn");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => safeCall(async () => {
        const ok = await copyTextToClipboard(code);
        copyBtn.textContent = ok ? "Скопировано ✓" : "Не вышло — скопируй вручную";
        setTimeout(() => { copyBtn.textContent = "Скопировать"; }, 2500);
      }));
    }
    return code;
  }

  /** Показать/спрятать код в поле ввода (глазок рядом с полем).
   *
   * Поле сделано типом password, чтобы браузер предлагал сохранить код у себя.
   * Но 25 знаков, набранных точками, читать нельзя — поэтому глазок переключает
   * тип на обычный текст.
   */
  function toggleCodeVisible() {
    const input = document.getElementById("loginCode");
    if (!input) return false;
    const hidden = input.getAttribute("type") !== "text";
    input.setAttribute("type", hidden ? "text" : "password");
    const btn = document.getElementById("toggleCodeBtn");
    if (btn) {
      btn.textContent = hidden ? "🙈" : "👁";
      btn.title = hidden ? "Спрятать код" : "Показать код";
    }
    if (hidden) {
      try {
        input.setSelectionRange(input.value.length, input.value.length);
      } catch (e) {
        // у type=text выделение можно не трогать — не критично
      }
    }
    return hidden;
  }

  /** Попросить браузер сохранить код (Chrome/Edge умеют; остальные просто молчат).
   *
   * Обычный вход браузер запоминает сам — он видит отправку формы с полем пароля.
   * А вот код, который только что сгенерировали, в форме не набирали, поэтому
   * предлагаем его сохранить явно. Способ необязательный: если браузер его не
   * знает или соединение не https, ничего не произойдёт — код всё равно можно
   * скопировать или скачать файлом.
   */
  async function offerToSaveCode(code, label) {
    if (!code) return false;
    const credentials = typeof navigator !== "undefined" ? navigator.credentials : null;
    const PasswordCredentialCtor = typeof window !== "undefined" ? window.PasswordCredential : null;
    if (!credentials || typeof credentials.store !== "function" || !PasswordCredentialCtor) return false;
    try {
      await credentials.store(new PasswordCredentialCtor({ id: label || "Chain Calc", password: code, name: "Chain Calc" }));
      return true;
    } catch (e) {
      // браузер не умеет, доступ запрещён или соединение не https
      return false;
    }
  }

  function inactiveDaysNow() {
    const me = state.account;
    return me && typeof me.inactiveDays === "number" ? Math.round(me.inactiveDays) : 30;
  }

  function downloadCodeFile(code) {
    const text = i18nText(
      `Код кабинета Chain Calc\n\n${code}\n\n` +
      "Это и логин, и пароль: по нему открывается кабинет с дампом и цепочками.\n" +
      "Сохрани файл в надёжном месте. Если код потеряется — в кабинете можно сменить его на новый.\n" +
      (inactiveDaysNow() ? `Если в кабинет не заходить ${inactiveDaysNow()} дней, он удаляется вместе с цепочками, дампом и иконками.\n` : ""));
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = i18nText("chain-calc-код-кабинета.txt");
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function createCabinet() {
    setLoginError("");
    const response = await fetch("/api/auth/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setLoginError(data.error || "сервер не смог создать кабинет");
      return null;
    }
    renderAccount({ authRequired: true, user: data.user, sessionDays: data.sessionDays });
    setLoginStep("code");
    showNewCode(data.code, data.migrated && data.migrated.skipped === false
      ? `В кабинет перенесены прежние цепочки (${data.migrated.chains}) и дампы (${data.migrated.datasets}).`
      : "");
    // Код только что создан, в форме его никто не набирал — просим браузер
    // сохранить его сам (там, где это умеют), и подставляем в поле входа.
    const input = document.getElementById("loginCode");
    if (input) input.value = data.code;
    offerToSaveCode(data.code, `кабинет №${data.user.number}`);
    return data;
  }

  async function loginByCode(code) {
    setLoginError("");
    const value = (code || "").trim();
    if (!value) {
      setLoginError("введи код кабинета");
      return null;
    }
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setLoginError(data.error || "код не подошёл");
      return null;
    }
    renderAccount({ authRequired: true, user: data.user, sessionDays: data.sessionDays });
    return data;
  }

  /** Вход выполнен: перезагружаем страницу.
   *
   * Перезагрузка тут не для красоты: браузер предлагает сохранить код именно
   * после отправки формы с полем пароля и перехода. Тесты живут без настоящей
   * перезагрузки — у них в заглушке location.reload только отмечает вызов.
   */
  async function finishLogin() {
    if (typeof location !== "undefined" && typeof location.reload === "function") {
      location.reload();
      return true;
    }
    await enterCabinet();
    return false;
  }

  /** Отправка формы входа: сюда ведут и «Войти», и «Я сохранил код — войти». */
  async function submitLogin() {
    const input = document.getElementById("loginCode");
    const value = (input && input.value ? input.value : "").trim();
    const codeStep = document.getElementById("loginStepCode");
    const onCodeStep = !!(codeStep && !codeStep.classList.contains("hidden"));
    if (!value) {
      if (onCodeStep) {          // кабинет только что создан — код уже сохранён
        await finishLogin();
        return true;
      }
      setLoginError("введи код кабинета");
      return false;
    }
    if (!(await loginByCode(value))) {
      // На шаге с новым кодом вход уже есть: если повторная отправка не прошла
      // (код успели сменить в другой вкладке), всё равно пускаем в кабинет.
      if (onCodeStep) {
        await finishLogin();
        return true;
      }
      return false;
    }
    await finishLogin();
    return true;
  }

  async function logoutCabinet() {    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (e) {
      console.error("выход не удался:", e);
    }
    renderAccount(null);
    state.dataset = null;
    state.datasetId = null;
    state.lastResult = null;
    showLogin("");
    const loginInput = document.getElementById("loginCode");
    if (loginInput) loginInput.value = "";
  }

  async function rotateCabinetCode() {
    if (!confirm("Сменить код кабинета? Старый код сразу перестанет работать, а входы на других устройствах закроются.")) {
      return null;
    }
    const response = await apiFetch("/api/auth/rotate", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.code) {
      alert("не смог сменить код: " + (data.error || "неизвестная ошибка"));
      return null;
    }
    renderAccount({ ...(state.account || {}), user: data.user });
    // Новый код тоже предлагаем сохранить: старый в браузере уже не работает.
    offerToSaveCode(data.code, `кабинет №${(data.user || {}).number || ""}`.trim());
    return showNewCode(data.code);
  }

  async function refreshDatasetList() {
    const list = await apiFetch("/api/datasets").then((r) => r.json());
    const sel = document.getElementById("datasetSelect");
    sel.innerHTML = '<option value="">— выбрать загруженный датасет —</option>';
    for (const item of list) {
      const id = typeof item === "string" ? item : item.id;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = typeof item === "string" ? id : datasetOptionText(item);
      sel.appendChild(opt);
    }
    renderCabinetDatasets(list);
    return list.map((item) => (typeof item === "string" ? item : item.id));
  }

  /** Подпись датасета в списке: дата, сколько рецептов и откуда он взялся. */
  function datasetOptionText(item) {
    const parts = [item.id];
    if (item.recipes) parts.push(`${item.recipes} рецептов`);
    if (item.uploadedAt) parts.push(new Date(item.uploadedAt).toLocaleString(uiLocale(), {
      day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
    }));
    return parts.join(" · ");
  }

  function renderCabinetDatasets(list) {
    const box = document.getElementById("cabinetDatasets");
    if (!box) return;
    if (!list || !list.length) {
      box.innerHTML = `<p class="hint msg">В кабинете пока нет ни одного дампа. Сделай его на своём
        компьютере и отправь батником <b>«отправить дамп на сервер.bat»</b>.</p>`;
      return;
    }
    const rows = list.map((item) => {
      const kind = item.knowsUnlocked === null || item.knowsUnlocked === undefined
        ? ""
        : item.knowsUnlocked
        ? "дамп из сохранения"
        : "полный дамп (только прототипы)";
      const size = item.size ? `${(item.size / (1024 * 1024)).toFixed(1)} МБ` : "";
      const when = item.uploadedAt ? new Date(item.uploadedAt).toLocaleString(uiLocale()) : "";
      return `<div class="cabinetDatasetRow"><b>${flowEscape(item.id)}</b>` +
        `<span class="hint">${[item.recipes ? `${item.recipes} рецептов` : "", kind, size, when]
          .filter(Boolean).map(flowEscape).join(" · ")}</span></div>`;
    });
    box.innerHTML = rows.join("");
  }

  // A dump is a file from outside (a user can upload anything to their cabinet), and its names go
  // into innerHTML and into quoted attributes all over the page. Replace the four characters that
  // could turn a name into markup with look-alikes; real names never need them.
  const UNSAFE_CHARS = /[<>"']/;
  const UNSAFE_CHARS_ALL = /[<>"']/g;
  const SAFE_LOOKALIKE = { "<": "\u2039", ">": "\u203a", '"': "\u201d", "'": "\u2019" };
  function sanitizeDataset(node) {
    if (!node || typeof node !== "object") return node;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "string") {
        if (UNSAFE_CHARS.test(value)) node[key] = value.replace(UNSAFE_CHARS_ALL, (ch) => SAFE_LOOKALIKE[ch]);
      } else if (value && typeof value === "object") {
        sanitizeDataset(value);
      }
    }
    return node;
  }

  // Some dumps carry no name for a recipe (the game could not translate it), and the page then showed the
  // internal id ("iron-plate") next to translated ingredients. A recipe without a name of its own is called
  // after what it makes: the item or fluid of the same name, else its first product - as in the game.
  function fillRecipeNames(dataset) {
    const items = dataset.items || {};
    const fluids = dataset.fluids || {};
    const nameOf = (type, name) => {
      const entry = (type === "fluid" ? fluids : items)[name];
      const text = entry && entry.display_name;
      return text && text !== name ? text : null;
    };
    for (const recipe of Object.values(dataset.recipes || {})) {
      if (recipe.display_name && recipe.display_name !== recipe.name) continue;
      let own = nameOf("item", recipe.name) || nameOf("fluid", recipe.name);
      if (!own) {
        const first = asArray(recipe.products)[0];
        if (first) own = nameOf(first.type || "item", first.name);
      }
      if (own) recipe.display_name = own;
    }
    return dataset;
  }

  async function loadDataset(id) {
    const data = await apiFetch(`/api/datasets/${id}`).then((r) => {
      if (!r.ok) throw new Error("dataset not found");
      return r.json();
    }).then(sanitizeDataset).then(fillRecipeNames);
    state.datasetId = id;
    state.dataset = data;
    if (window.i18n) window.i18n.registerDataset(data); // English item/recipe names for the UI
    moduleCatalogCache = null; // module list & user overrides are per-dataset
    state.onlyUnlocked = searchUnlockedInitial(id);
    renderBeltButtons();
    loadInserterSetup(id); // раздел «Манипуляторы» общий для всех дампов
    refreshInserterOffer();
    renderInserterTable();
    renderRecipeFilter();
    renderSettings();      // «Настройки»: про полный дамп там появляется предупреждение
    // В шапке — вид дампа, сколько изучено и когда загружен (см. datasetStatusText).
    document.getElementById("datasetStatus").textContent = datasetStatusText(id, data);
    document.getElementById("datasetStatus").classList.add("ok");
    document.getElementById("datasetSelect").value = id;
    localStorage.setItem(LAST_DATASET_KEY, id);
    renderRecipeSearch();
  }

  async function deleteCurrentDataset() {
    const id = document.getElementById("datasetSelect").value;
    if (!id) return alert("Сначала выбери датасет в списке.");
    if (!confirm(`Удалить датасет "${id}" насовсем?`)) return;
    await apiFetch(`/api/datasets/${id}`, { method: "DELETE" });
    if (state.datasetId === id) {
      state.datasetId = null;
      state.dataset = null;
      document.getElementById("datasetStatus").textContent = "датасет не загружен";
      document.getElementById("datasetStatus").classList.remove("ok");
      if (localStorage.getItem(LAST_DATASET_KEY) === id) localStorage.removeItem(LAST_DATASET_KEY);
      renderRecipeSearch();
    }
    await refreshDatasetList();
  }

  async function uploadDataset(file) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await apiFetch("/api/datasets", { method: "POST", body: fd }).then((r) => r.json());
    if (res.error) {
      alert("Ошибка загрузки датасета: " + res.error);
      return;
    }
    await refreshDatasetList();
    document.getElementById("datasetSelect").value = res.id;
    await loadDataset(res.id);
  }

  // Node ids are `n1`, `n2`, ... and the counter restarts at 1 on every page load,
  // while a chain loaded from the server brings its own ids along. Adding a node
  // after that could hand out an id that is already in use - and since everything
  // is keyed by id (the solver's result, findTreeNodeById, collectResultEdits) one
  // stage card would silently take over another's numbers. Move the counter past
  // whatever the loaded chain already uses.
  function syncUidCounter(tabs) {
    let maxSeen = 0;
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      const m = /^n(\d+)$/.exec(String(node.id || ""));
      if (m) maxSeen = Math.max(maxSeen, parseInt(m[1], 10));
      for (const child of Object.values(node.children || {})) visit(child);
    };
    for (const t of tabs || []) {
      const cascade = (t && t.cascade) || {};
      if (cascade.root) visit(cascade.root);
    }
    if (maxSeen >= uidCounter) uidCounter = maxSeen + 1;
    return uidCounter;
  }

  function makeDefaultNode(recipe, primaryKeyHint) {
    const machines = compatibleMachines(state.dataset, recipe);
    const products = asArray(recipe.products);
    // The hint can be a temperature RANGE from the raw-input list
    // (`fluid:steam@500:<FLT_MAX>`), which is what the recipe DEMANDS, not what
    // it produces. Solving a node whose primaryProduct is a demand band raised
    // "рецепт X не производит fluid:steam@500:...". Always store the recipe's own
    // product key instead.
    const primaryProduct = resolveRecipeProductKey(
      recipe,
      primaryKeyHint || itemKey(products[0]?.type || "item", products[0]?.name || "?")
    );
    const defaultMachine = machines[0];
    const fuels = compatibleFuels(state.dataset, defaultMachine);
    return {
      id: uid(),
      recipeName: recipe.name,
      machineName: defaultMachine?.name,
      fuelItem: fuels[0]?.name || null,
      modules: [], // [{name, count}] - installed modules, see MODULES section
      beacon: { name: null, count: 0, modules: [] }, // see BEACONS section
      manualEffects: { speed: 0, productivity: 0, consumption: 0 }, // beacons / anything we don't model
      effects: { speed: 0, productivity: 0, consumption: 0, quality: 0 }, // COMPUTED: manual + modules
      primaryProduct,
      children: {},
      collapsed: {}, // { ingredientKey: true } - explicitly closed by the user
    };
  }

  // ---- "Что можно сделать из <основного ресурса>" panel ----
  // The main resource is the product of the FIRST tab (the current end product,
  // "стоит первый"). This panel lists recipes that CONSUME it, so you can push
  // the chain one step further downstream.
  function mainResourceInfo() {
    const c = calcTabs[0] && getTabCascade(calcTabs[0].id);
    if (!c || !c.root || !c.root.primaryProduct) return null;
    // targetRate is stored per-second internally; unit is only for display.
    return { key: c.root.primaryProduct, rateSec: c.targetRate || 0, unit: c.targetRateUnit || "sec" };
  }
  function mainResourceKey() {
    const info = mainResourceInfo();
    return info ? info.key : null;
  }

  function recipesConsuming(itemKeyStr) {
    // The key can carry a temperature (`fluid:steam@250`, `fluid:hot-molten-salt@1000`)
    // while the index is built from plain `type:name` keys. Looking the tagged key up
    // verbatim found NOTHING, so the panel claimed there are no recipes turning
    // «Пар 250°» into anything (measured: 0 against 106 for `fluid:steam`).
    const [type, name] = keyBaseParts(itemKeyStr);
    return recipeIndex(state.dataset).consumers.get(itemKey(type, name)) || [];
  }

  // The product this recipe is interesting for = its first product that ISN'T
  // the resource we're feeding in (fall back to the first product).
  function pickProductKey(recipe, excludeKey) {
    const products = asArray(recipe.products);
    const [exType, exName] = keyBaseParts(excludeKey || "");
    const different = products.find((p) => (p.type || "item") !== exType || p.name !== exName);
    const pick = different || products[0];
    return pick ? itemKey(pick.type || "item", pick.name) : null;
  }
  function ingredientAmount(recipe, key) {
    const [type, name] = keyBaseParts(key);
    let sum = 0;
    for (const ing of asArray(recipe.ingredients)) {
      if ((ing.type || "item") === type && ing.name === name) sum += Number(ing.amount) || 0;
    }
    return sum;
  }
  function productAmount(recipe, key) {
    const [type, name] = keyBaseParts(key);
    let sum = 0;
    for (const p of asArray(recipe.products)) {
      if ((p.type || "item") !== type || p.name !== name) continue;
      const amt = p.amount != null ? Number(p.amount) : ((Number(p.amount_min) || 0) + (Number(p.amount_max) || 0)) / 2;
      sum += (amt || 0) * (p.probability != null ? p.probability : 1); // expected yield per craft
    }
    return sum;
  }

  function renderMakeFromPanel() {
    const panel = document.getElementById("makeFromPanel");
    if (!panel) return;
    const titleEl = document.getElementById("makeFromTitle");
    const list = document.getElementById("makeFromList");
    const main = mainResourceInfo();
    if (!main || !state.dataset) {
      panel.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    const mainName = keyDisplayName(state.dataset, main.key);
    if (titleEl) titleEl.textContent = `Что можно сделать из «${mainName}»`;
    // recipes that turn the main resource into something else - skip the ones
    // that merely destroy/incinerate/void it (not a real production step).
    const recipes = recipesConsuming(main.key).filter((r) => compatibleMachines(state.dataset, r).length);
    list.innerHTML = "";
    if (!recipes.length) {
      list.innerHTML = `<p class="hint msg">Нет рецептов, где «${mainName}» превращается во что-то другое.</p>`;
      return;
    }
    const unitLabel = main.unit === "min" ? "/мин" : "/сек";
    recipes.forEach((r) => {
      const targetKey = pickProductKey(r, main.key);
      if (!targetKey) return;
      const g = ingredientAmount(r, main.key);
      const p = productAmount(r, targetKey);
      // If we pour our whole current output of the main resource into this
      // recipe, this is how much of the product per unit time we'd get.
      const outSec = main.rateSec > 0 && g > 0 ? (main.rateSec * p) / g : 0;
      const outDisplay = main.unit === "min" ? outSec * 60 : outSec;
      const card = document.createElement("div");
      card.className = "inputResBtn makeFromCard clickableForChain";
      card.dataset.recipe = r.name;
      card.title = `${recipeDisplayName(r)} — сделать первой закладкой и посчитать`;
      card.innerHTML = `${iconImg(keyIconUrl(state.dataset, targetKey), 32)}<span>${keyDisplayName(state.dataset, targetKey)}</span><span class="makeFromRate">${
        outDisplay > 0 ? `${+outDisplay.toFixed(2)}${unitLabel}` : "—"
      }</span>`;
      card.addEventListener("click", () => safeCall(() => pickMakeFromRecipe(r.name)));
      list.appendChild(card);
    });
  }

  // Строит цепочку выбранного продукта и ставит её новой первой вкладкой, считает под её
  // собственный выход. Прежняя цепочка остаётся в очереди позади.
  //
  // Новая первая вкладка — другая цепочка (другой конечный продукт): загруженная запись
  // отпускается (сохранение создаст новую), цепочка называется по новому продукту.
  async function pickMakeFromRecipe(recipeName) {
    const recipe = state.dataset.recipes[recipeName];
    if (!recipe) return;
    const mainKey = mainResourceKey();
    const node = makeDefaultNode(recipe, pickProductKey(recipe, mainKey));
    saveCurrentTabSnapshot();
    state.chainId = null;
    const id = "t" + Math.random().toString(36).slice(2);
    calcTabs.unshift({ id });
    tabSnapshots[id] = { cascade: { root: node, targetRate: 1, targetRateUnit: "sec" }, lastResult: null, inputPairs: {} };
    activeTabIndex = 0;
    loadTabIntoState(0);
    await runSolve();
    renderResults();
    renderInputResources();
    const nameInput = document.getElementById("chainName");
    if (nameInput) nameInput.value = chainNameFromFirstTab();
  }

  // Building a fresh root (from the recipe search, etc.) starts a new
  // chain - "Сохранить" must create a NEW saved entry, not silently
  // overwrite whatever was loaded/saved before.
  function forgetSavedChainId() {
    state.chainId = null;
    resetCalcTabs();
    const link = document.getElementById("shareLink");
    if (link) {
      link.classList.add("hidden");
      link.textContent = "";
    }
    const nameInput = document.getElementById("chainName");
    if (nameInput) nameInput.value = "";
  }

  // If there's unsaved work, offer to save it before it gets replaced.
  // OK = save first, then continue; Cancel = discard and continue anyway
  // (this never blocks the action outright, just offers the save).
  async function confirmDiscardIfDirty() {
    if (!state.dirty || !state.cascade.root) return;
    const wantsSave = confirm("В текущей цепочке есть несохранённые изменения. Сохранить её перед тем как начать новую?");
    if (wantsSave) {
      await saveChain();
    }
  }

  async function startNewRootChain(newRoot, shouldCalculate) {
    await confirmDiscardIfDirty();
    state.cascade.root = newRoot;
    clearChainChest();
    forgetSavedChainId();
    if (shouldCalculate) {
      await runCalculation();
    }
  }

  // ---------- rendering: cascade tree (vertical, indented rows) ----------
  //
  // Each row = one confirmed recipe node:
  //   [other outputs]  ICON  name + machine/effects   [ ингредиент1: candidates ]
  //                                                     [ ингредиент2: candidates ]
  // - "other outputs" (left) only show up if the recipe makes more than one
  //   product - clicking one makes IT the tracked output instead (replaces
  //   the old dropdown).
  // - each ingredient's candidate recipes (right) are always shown as
  //   buttons; the selected one is highlighted, and its own chain continues
  //   below, indented one level deeper. Clicking the selected candidate
  //   again collapses it (explicitly, via node.collapsed) instead of
  //   re-resolving immediately, so a single-candidate ingredient can still
  //   be tidied away.
  // - clicking any icon anywhere shows its Russian name as a native tooltip
  //   (title attribute).

  // В списке у выхода видны все заводы категории. Завод, которого ещё нет у пользователя,
  // помечен (не изучен в сохранении или не скрафтить), чтобы не посчитать цепочку под
  // недоступную постройку.
  //
  // Про скрытый рецепт пишется «не крафтится», а не «не получить»: дамп показывает только,
  // что игра не показывает рецепт в меню крафта; лут, стартовый набор или скрипт дамп не
  // описывает.
  function machineSelectHTML(dataset, recipe, selected) {
    const machines = compatibleMachines(dataset, recipe);
    const knows = datasetKnowsUnlocked(dataset);
    return machines
      .map((m) => {
        const blocked = machineBuildable(dataset, m.name) === false;
        const mark = blocked
          ? " — не крафтится (рецепт скрыт)"
          : knows && !machineUnlocked(dataset, m.name)
          ? " — ещё не изучен"
          : "";
        return `<option value="${m.name}" data-icon="${machineIconUrl(m) || ""}" ${m.name === selected ? "selected" : ""}>${machineDisplayName(m)}${mark}</option>`;
      })
      .join("");
  }

  /** Завод этапа, который в игре не скрафтить: сказать об этом и предложить замену.
   *
   *  Рецепт ванильного химического завода в Py скрыт, а в сохранённой цепочке он мог
   *  остаться. Расчёт, чертёж и сундук запроса работали бы с недоступной постройкой, поэтому
   *  в карточке пишется предупреждение и стоит кнопка «поставить тот, который строится».
   */
  function machineCraftWarning(recipeName, machineName) {
    const dataset = state.dataset;
    if (!dataset || !machineName) return null;
    if (machineBuildable(dataset, machineName) !== false) return null;
    const recipe = (dataset.recipes || {})[recipeName] || {};
    const better = compatibleMachines(dataset, recipe)
      .find((m) => machineBuildable(dataset, m.name) !== false);
    const current = (dataset.entities || {})[machineName] || { name: machineName };
    return { machine: machineName, label: machineDisplayName(current), better: better || null };
  }

  function machineCraftNoteHTML(nodeId, recipeName, machineName) {
    const warning = machineCraftWarning(recipeName, machineName);
    if (!warning) return "";
    const better = warning.better
      ? ` В списке есть «${machineDisplayName(warning.better)}»` +
        (nodeId
          ? `: <button type="button" class="btn btn-ghost machineReplaceBtn" data-node="${nodeId}" ` +
            `data-machine="${warning.better.name}" title="Поставить этот завод и пересчитать">Поставить его</button>`
          : ".")
      : " Другого завода под этот рецепт в дампе нет.";
    return `<div class="machineCraftWarn">⚠ выбран завод «${warning.label}» — в игре его не скрафтить `
      + `(рецепт скрыт).${better}</div>`;
  }

  /** Заменить завод этапа и пересчитать: то же, что выбрать его в списке. */
  async function setStageMachine(nodeId, machineName) {
    const node = findTreeNodeById(state.cascade && state.cascade.root, nodeId);
    if (!node || !machineName || node.machineName === machineName) return;
    node.machineName = machineName;
    // Топливо и модули зависят от завода: у нового свой первый подходящий набор.
    node.fuelItem = null;
    ensureNodeEffects(node);   // заодно подставит топливо нового завода
    await recalcChainAndTabs(false);
  }

  const INDENT_PX = 30;

  // ---------- rendering: matrix/block view ----------

  // A recipe that just incinerates/destroys its input (Pyanodon has several
  // "void this item for a bit of ash/power" recipes) isn't a real production
  // step - the item isn't being combined or processed into something, it's being
  // disposed of. isJunkRecipe drops those from every producer list and search.
  const DESTRUCTIVE_KEYWORDS = ["уничтож", "сжиг", "сжечь", "утилиз", "incinerat", "destroy", "void", "burn"];
  function isDestructiveRecipe(recipe) {
    // A recipe that PRODUCES A MACHINE is a production step whatever its name says:
    // Pyanodon's «Сжигатель» (recipe `py-burner`, display "Сжигатель") is a real
    // furnace built from plates, and the "burn"/"сжиг" keyword junked it - the item
    // then had no producer anywhere in the calculator.
    const entities = (state.dataset && state.dataset.entities) || {};
    for (const p of asArray(recipe.products)) {
      if (entities[p.name]) return false;
    }
    const name = (recipe.display_name || recipe.name || "").toLowerCase();
    const category = (recipe.category || "").toLowerCase();
    return DESTRUCTIVE_KEYWORDS.some((k) => name.includes(k) || category.includes(k));
  }

  /** Producers the junk filter threw away (barrels, void, incineration, ...). */
  function ignoredProducers(dataset, key) {
    const [type, name] = keyBaseParts(key);
    const out = [];
    for (const recipe of Object.values((dataset && dataset.recipes) || {})) {
      if (!isJunkRecipe(recipe)) continue;
      if (asArray(recipe.products).some((p) => (p.type || "item") === type && p.name === name)) out.push(recipe);
    }
    return out;
  }

  // ---------- recipe search ----------
  //
  // One text box: type part of a recipe name, of what it makes or of what it needs. Every word has to
  // match; the internal id ("iron-plate") is searched too, so English works whatever the dump language.
  // Click a recipe - it becomes the root of a new chain and the calculation opens.

  const RECIPE_SEARCH_LIMIT = 60;

  function recipeSearchText(dataset, recipe) {
    const names = (list) => asArray(list).map((p) => `${itemDisplayName(dataset, p.type || "item", p.name)} ${p.name}`).join(" ");
    return {
      name: `${recipeDisplayName(recipe)} ${recipe.name}`.toLowerCase().replace(/[-_]+/g, " "),
      products: names(recipe.products).toLowerCase().replace(/[-_]+/g, " "),
      ingredients: names(recipe.ingredients).toLowerCase().replace(/[-_]+/g, " "),
    };
  }

  /** Recipes matching `query` (all words), best first: by name, then by product, then by ingredient, then anywhere. */
  function searchRecipes(dataset, query, limit) {
    const words = String(query || "").toLowerCase().replace(/[-_]+/g, " ").split(/\s+/).filter(Boolean);
    if (!dataset || !words.length) return { total: 0, shown: [] };
    const phrase = words.join(" ");
    const scored = [];
    for (const recipe of usableRecipes(dataset)) {
      const text = recipeSearchText(dataset, recipe);
      const has = (hay) => words.every((w) => hay.includes(w));
      let rank;
      if (has(text.name)) rank = text.name.startsWith(phrase) ? 0 : 1;
      else if (has(text.products)) rank = 2;
      else if (has(text.ingredients)) rank = 3;
      else if (has(`${text.name} ${text.products} ${text.ingredients}`)) rank = 4;   // words spread over the recipe
      else continue;
      scored.push({ recipe, rank, len: text.name.length });
    }
    scored.sort((a, b) => a.rank - b.rank || a.len - b.len || a.recipe.name.localeCompare(b.recipe.name));
    return { total: scored.length, shown: scored.slice(0, limit || RECIPE_SEARCH_LIMIT).map((x) => x.recipe) };
  }

  function renderRecipeSearch() {
    const box = document.getElementById("recipeResults");
    if (!box) return;
    box.innerHTML = "";
    if (!state.dataset) return;
    const input = document.getElementById("recipeSearch");
    const query = input ? input.value.trim() : "";
    if (!query) {
      box.innerHTML = `<p class="hint msg">Начни вводить название рецепта или предмета.</p>`;
      return;
    }
    const { total, shown } = searchRecipes(state.dataset, query);
    if (!shown.length) {
      box.innerHTML = `<p class="error">Ничего не нашлось по запросу «${escapeHtmlText(query)}».</p>`;
      return;
    }
    const title = document.createElement("p");
    title.className = "hint";
    title.textContent = total > shown.length
      ? `Найдено ${total}, показаны первые ${shown.length} — уточни запрос. Кликни по рецепту, чтобы собрать цепочку и сразу перейти к расчёту.`
      : `Найдено ${total}. Кликни по рецепту, чтобы собрать цепочку и сразу перейти к расчёту.`;
    box.appendChild(title);
    shown.forEach((recipe) => {
      const div = document.createElement("div");
      div.className = "pathOption";
      div.innerHTML = `<div class="pathOptionMain"><div class="recipeTitleBlock"><div class="routeSteps"><span class="step">${iconImg(
        recipeIconUrl(recipe),
        22
      )}${disambiguatedLabel(recipe, shown)}</span></div>${recipeMachineHTML(recipe)}</div>${recipeIOHTML(recipe)}</div>`;
      div.addEventListener("click", () => safeCall(() => startNewRootChain(makeDefaultNode(recipe), true)));
      box.appendChild(div);
    });
  }

  function escapeHtmlText(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  // Given a recipe and a plain-name key, return the recipe's own
  // (possibly temperature-tagged) key for that product.
  function resolveRecipeProductKey(recipe, plainKey) {
    const parsed = parseFluidKey(plainKey);
    if (!parsed) return plainKey;
    for (const p of asArray(recipe.products)) {
      if ((p.type || "item") === "fluid" && p.name === parsed[0]) return specKey(p);
    }
    return plainKey;
  }

  // ---------- results ----------

  // ---------- belt throughput planning ----------
  // Only meaningful for solid items (belts) - fluids go through pipes and
  // are skipped entirely, per spec.

  // `direction` is "out" (finished product leaving the machines) or "in"
  // (ingredient being fed to them). В обоих случаях потолок — скорость ленты:
  //  - OUTPUT: свой поток завод может разложить по обеим полосам (манипулятор на
  //    каждую полосу или слияние полос), поэтому лента берёт
  //    floor(beltSpeed / perMachine) заводов. Если одному заводу нужно больше
  //    целой ленты — ему нужно несколько лент.
  //  - INPUT: заводы снимают ресурс с ленты, важен только поток: столько же.
  //    (Это правило и было: «1 лента 15/сек не прокормит 2 завода по 20».)
  // Ресурс, который ДЕЛИТ ленту с соседом (по полосе каждому), считается
  // отдельно — там доступна только своя полоса (beltIdealMachines(x, false)).
  function computeBeltPlan(ratePerSec, exactMachines, direction) {
    if (!ratePerSec || !exactMachines || exactMachines <= 0) return null;
    const beltSpeed = state.belt.speed;
    const laneSpeed = beltSpeed / 2;
    if (laneSpeed <= 0) return null;
    const perMachine = ratePerSec / exactMachines;
    if (perMachine <= 0) return null;
    const totalMachines = Math.max(1, Math.ceil(exactMachines - 1e-9));

    let beltsPerMachine = 1;
    // Потолок один и для входа, и для выхода — скорость ленты (см. выше).
    const machinesPerBelt = perMachine <= beltSpeed + 1e-9
      ? Math.floor(beltSpeed / perMachine + 1e-9)
      : 0;                      // одному заводу нужно несколько лент
    const oneMachineNeedsMultipleBelts = machinesPerBelt < 1;
    if (oneMachineNeedsMultipleBelts) beltsPerMachine = Math.ceil(perMachine / beltSpeed - 1e-9);

    const perBelt = Math.max(1, machinesPerBelt); // machines that fill one belt
    const totalBelts = oneMachineNeedsMultipleBelts ? totalMachines * beltsPerMachine : Math.ceil(totalMachines / perBelt);
    const lastBeltMachines = oneMachineNeedsMultipleBelts ? 1 : totalMachines - (totalBelts - 1) * perBelt;
    const lastBeltRate = oneMachineNeedsMultipleBelts ? perMachine / beltsPerMachine : lastBeltMachines * perMachine;
    const lastFillPct = Math.min(100, (lastBeltRate * 100) / beltSpeed);

    return {
      beltSpeed,
      laneSpeed,
      perMachine,
      totalMachines,
      machinesPerBelt: perBelt,
      lastBeltMachines,
      totalBelts,
      lastFillPct,
      oneMachineNeedsMultipleBelts,
      beltsPerMachine,
      direction,
    };
  }

  function beltFillBarHTML(pct) {
    const clamped = Math.min(100, Math.max(0, pct));
    return `<span class="beltFillBar${pct > 100 ? " over" : ""}"><div style="width:${clamped}%"></div></span>${pct.toFixed(0)}%`;
  }

  // ---- «как есть»: сколько заводов обслуживает одна лента -------------------
  // Одна лента несёт capacity/сек, завод берёт (или отдаёт) perMachine/сек,
  // значит лента обслуживает ровно capacity/perMachine заводов — и это число
  // ДРОБНОЕ. 7.5 — это не «7» и не «8», а «7 заводов полностью и ещё один на
  // половину». Округление вниз молча теряет ползавода, округление вверх
  // заставляет строить лишнюю ленту там, где хватает одной.
  function machinesPerBelt(ratePerMachine, capacity) {
    if (!(ratePerMachine > 0) || !(capacity > 0)) return 0;
    return capacity / ratePerMachine;
  }

  /** 7.5 → «7.5», 7 → «7», 7.25 → «7.25» (без хвостовых нулей). */
  function fmtMachinesText(x) {
    return Number(x).toFixed(2).replace(/\.?0+$/, "");
  }

  /** «7 заводов полностью и ещё один на 50% (итого 7.5 завода)» */
  function machinesPerBeltText(x) {
    if (!(x > 0)) return "ни одного завода";
    let whole = Math.floor(x + 1e-6);
    let pct = Math.round((x - whole) * 100);
    if (pct >= 100) {
      whole += 1;
      pct = 0;
    }
    if (pct <= 0) return `${whole} ${pluralMachines(whole)}`;
    const tail = whole === 0 ? `один завод на ${pct}%` : `${whole} ${pluralMachines(whole)} полностью и ещё один на ${pct}%`;
    return `${tail} (итого ${fmtMachinesText(x)} завода)`;
  }

  // Сколько целых заводов максимум может стоять в одной группе: все, кроме
  // последнего, работают на полную, а последнему достаётся остаток ленты. То
  // есть заводов помещается «на один больше», чем машин-эквивалентов ленты:
  // лента на 7.5 завода = группа из 8, где восьмой недогружен.
  function maxGroupPhysical(cap) {
    if (!(cap > 1 + 1e-9)) return 1;
    return Math.max(1, Math.floor(cap + 1 + 1e-9));
  }

  // Сколько заводов заполняют ОДНУ ленту для одного ресурса.
  //
  // Потолок — скорость ленты: поток раскладывается по обеим полосам (манипулятор на каждую
  // полосу или слияние полос), поэтому лента берёт floor(скорость_ленты / на_завод).
  //
  // `bothSides=false` — ресурс делит ленту с соседом (по полосе каждому): доступна только
  // своя полоса, и её ёмкость — потолок.
  function beltIdealMachines(perMachineRate, bothSides) {
    if (!(perMachineRate > 0)) return 1;
    const capacity = bothSides ? state.belt.speed : state.belt.speed / 2;
    return Math.max(1, Math.floor(capacity / perMachineRate + 1e-9));
  }

  // Per-line «Полная лента». `laneOnly` is for a resource that SHARES its belt with
  // another one (one resource per side): filling the whole belt alone is not on the
  // table there, so the button fills its own side instead.
  // ---------- «Приоритет»: согласовать вход и выход ---------------------------
  // Подача и выгрузка отвечают на РАЗНЫЕ вопросы: подача — сколько лент нужно,
  // чтобы прокормить заводы (считается по потоку сырья), выгрузка — сколько
  // заводов выгружается на одну ленту (считается по блокам/сторонам). Поэтому
  // группы у них не совпадают, и это выглядит как «вход и выход показывают
  // разные группы».
  //
  // Кнопка у «Входа» заставляет ВЫХОД считаться по группам подачи, кнопка у
  // «Выхода» — ПОДАЧУ по блокам выгрузки. Повторное нажатие возвращает обычный
  // вид, когда каждая сторона считается по своему правилу. Выбор хранится в
  // узле цепочки, поэтому переживает сохранение и загрузку.
  // Кнопки приоритета убраны: приоритет ВСЕГДА «выход». Так подача режется по
  // блокам выгрузки, то есть каждый блок получает полную ленту — именно это и
  // нужно, когда строишь по блюпринтам (лента уходит нагруженной).
  function stageAlignPriority(nodeId) {
    return "out";
  }

  function priorityButtonHTML(nodeId, side, current) {
    if (!nodeId) return "";
    const active = current === side;
    const title = active
      ? "Вернуть обычный вид: вход считается по потоку сырья, выход — по блокам выгрузки"
      : side === "in"
      ? "Приоритет — вход: считать ВЫХОД по этим группам подачи (сколько лент нужно каждой группе и всему этапу)"
      : "Приоритет — выход: нарезать ПОДАЧУ по блокам выгрузки (сколько лент нужно каждому блоку)";
    const label = active ? (side === "in" ? "Приоритет: вход ✓" : "Приоритет: выход ✓") : "Приоритет";
    return `<button type="button" class="beltPriorityBtn${active ? " active" : ""}" data-node="${nodeId}" data-side="${side}" title="${title}">${label}</button>`;
  }

  function toggleStagePriority(nodeId, side) {
    const treeNode = findTreeNodeById(state.cascade && state.cascade.root, nodeId);
    if (!treeNode) return;
    if (treeNode.alignPriority === side) delete treeNode.alignPriority;
    else treeNode.alignPriority = side;
    // Это решение о раскладке, а не о производительности: пересчитывать цепочку
    // не нужно, достаточно перерисовать.
    saveCurrentTabSnapshot();
    state.dirty = true;
    renderResults();
    renderInputResources();
  }

  /** «Полная лента этого ресурса» — кнопка во входе у каждого ресурса.
   *
   *  Если ресурс в группе с другим едет по общей ленте, группа разбивается и/или
   *  пересобирается так, чтобы этот ресурс ехал один по всей ленте; пересчитывается весь
   *  рецепт и все вкладки этого рецепта.
   *
   *  `shared` — ресурс сейчас делит ленту с соседом: кнопка ещё и разбивает пару (это
   *  сказано в подсказке).
   */
  function fullBeltResourceLineButtonHTML(nodeId, key, shared) {
    if (!nodeId) return "";
    const title = shared
      ? "Разбить пару: этот ресурс поедет своей лентой и займёт её целиком. Цепочка и все вкладки этого рецепта пересчитаются"
      : "Пересчитать всю цепочку так, чтобы этот ресурс занимал ровно одну полную ленту";
    return `<button type="button" class="fullBeltBtn fullBeltInputBtn" data-node="${nodeId}" data-key="${key}" data-dir="in" data-solo="${
      shared ? "1" : "0"
    }" title="${title}">Полная лента этого ресурса</button>`;
  }

  // Whole-resource version for the «Входящие ресурсы» panel: there the resource
  // belongs to the chain, not to one stage, so we scale the chain until its total
  // demand fills a belt (or its own side of a shared one).
  function fullBeltResourceButtonHTML(key) {
    const title = "Пересчитать всю цепочку так, чтобы этот ресурс занимал ровно одну полную ленту — своей лентой, а не половинкой на пару с соседом";
    return `<button type="button" class="fullBeltBtn fullBeltResourceBtn" data-key="${key}" title="${title}">Полная лента этого ресурса</button>`;
  }

  // A belt line is already «полная лента» when it fits in exactly one belt and
  // that belt is filled by a whole belt's worth of machines - pressing «Полная
  // лента» there would change nothing, so we hide the button. The numbers on
  // such a line still refresh on their own if the button is pressed elsewhere
  // and the whole chain gets rescaled.
  function beltLineIsAlreadyFullBelt(plan) {
    return !!plan && !plan.oneMachineNeedsMultipleBelts && plan.totalBelts === 1 && plan.totalMachines === plan.machinesPerBelt;
  }

  // Fluids and gases travel by pipe, not by belt, so «полная лента» makes no
  // sense for them - instead their rate is directly editable. Small rates read
  // best per second; once a rate climbs into the thousands per second it reads
  // better per minute, so the unit is chosen automatically per value.
  const FLUID_PER_MIN_THRESHOLD = 1000; // rate/sec at/above which we show /min

  function pickFluidUnit(ratePerSec) {
    return ratePerSec >= FLUID_PER_MIN_THRESHOLD ? "min" : "sec";
  }

  // Short, human number: whole when it's (near) integer, else up to two
  // decimals with no trailing zeros.
  function formatFluidNumber(v) {
    if (!isFinite(v)) return "0";
    const rounded = Math.round(v);
    if (Math.abs(v - rounded) < 1e-6) return String(rounded);
    return parseFloat(v.toFixed(2)).toString();
  }

  // Inline editable rate field for one fluid/gas. Enter commits and rescales
  // the whole chain (a delegated keydown listener does the work). We stash the
  // current per-second rate on the element so the handler can compute the
  // scale factor no matter which unit is on screen.
  function fluidRateEditorHTML(key, ratePerSec) {
    const unit = pickFluidUnit(ratePerSec);
    const shown = unit === "min" ? ratePerSec * 60 : ratePerSec;
    const label = unit === "min" ? "/мин" : "/сек";
    return `<input type="text" inputmode="decimal" class="fluidRateInput" data-persec="${ratePerSec}" data-unit="${unit}" value="${formatFluidNumber(
      shown
    )}" title="Изменить число и нажать Enter — вся цепочка и вкладки пересчитаются под это значение" /><span class="fluidRateUnit">${label}</span>`;
  }

  // A node's fluid/gas lines (ingredients or products). Belts are rendered
  // elsewhere; here every entry is a pipe with an editable rate.
  // A recipe that both consumes and produces the same thing (Formamide keeps
  // 100 methanol on each side) still shows that thing as a normal input and
  // output - the user wants it clickable and sized as if made fresh. We just add
  // a note saying how much loops, so they know to close the pipe: "надо
  // зациклить N", the amount straight from the current recalc.
  function renderCirculating(n) {
    const loops = Object.entries((n && n.circulating) || {}).filter(([, rate]) => rate > 1e-9);
    if (!loops.length) return "";
    const rows = loops.map(([key, rate]) => {
      const name = keyDisplayName(state.dataset, key);
      const icon = iconImg(keyIconUrl(state.dataset, key), 16);
      const isFluid = key.startsWith("fluid:");
      const amount = isFluid ? `${formatFluidNumber(rate)} /сек` : `${(+rate.toFixed(3)).toLocaleString(uiLocale())} шт/сек`;
      return `<li>${icon}<b>${name}</b>: ${
        isFluid ? "по трубе — " : ""
      }надо зациклить <b>${amount}</b> <span class="hint">(входит и выходит из этого же рецепта)</span></li>`;
    });
    return `<div class="beltSubLabel circulatingLabel">🔄 Ходит по кругу:</div>
      <ul class="beltList circulatingList">${rows.join("")}</ul>`;
  }

  function renderFluidLines(itemsMap, editable) {
    const fluids = Object.entries(itemsMap || {}).filter(([k, v]) => k.startsWith("fluid:") && v > 0);
    if (!fluids.length) return "";
    const rows = fluids.map(([key, rate]) => {
      const name = keyDisplayName(state.dataset, key);
      const icon = iconImg(keyIconUrl(state.dataset, key), 16);
      const rateHtml = editable ? fluidRateEditorHTML(key, rate) : `<b>${formatFluidNumber(rate)}</b> /сек`;
      return `<li>${icon}<b>${name}</b>: ${rateHtml} <span class="hint">(по трубе, лента не нужна)</span></li>`;
    });
    return `<ul class="beltList fluidList">${rows.join("")}</ul>`;
  }

  function renderItemsBeltCell(itemsMap, machinesExact, direction, nodeId) {
    const items = Object.entries(itemsMap || {}).filter(([key]) => key.startsWith("item:"));
    // Fluid-only nodes used to show a generic note here; their fluids are now
    // rendered (editable) by renderFluidLines right next to this cell, so we
    // just return nothing and let that list speak for itself.
    if (!items.length) return "";
    const rows = items.map(([key, ratePerSec]) => {
      const plan = computeBeltPlan(ratePerSec, machinesExact, direction);
      const name = keyDisplayName(state.dataset, key);
      const icon = iconImg(keyIconUrl(state.dataset, key), 16);
      // «Полная лента» есть только у входа (см. renderStageFeedSection), у продуктов на выходе её нет.
      const fullBeltBtn =
        direction === "in" && nodeId && !beltLineIsAlreadyFullBelt(plan)
          ? fullBeltResourceLineButtonHTML(nodeId, key, false)
          : "";
      if (!plan) return `<li>${icon}${name}: — ${fullBeltBtn}</li>`;
      return beltLineHTML(icon, name, plan, fullBeltBtn, direction);
    });
    return `<ul class="beltList">${rows.join("")}</ul>`;
  }

  // One belt line, same shape for input and output: how many machines fit on
  // one belt, how many belts total, and how full the last one is. OUTPUT
  // machines stand on both sides of the belt they unload onto; INPUT machines
  // pull off the supply belt. Both are counted honestly by throughput now.
  function beltLineHTML(icon, name, plan, fullBeltBtn, direction) {
    const verb = direction === "out" ? "выгружают" : "берут сырьё";
    const start = `${icon}<b>${name}</b>: ${plan.totalMachines} ${pluralMachines(plan.totalMachines)} ${verb} →`;
    if (plan.oneMachineNeedsMultipleBelts) {
      const warnVerb = direction === "out" ? "выдаёт" : "потребляет";
      return `<li>${start} каждому заводу нужно <b>${plan.beltsPerMachine} ${pluralBelts(plan.beltsPerMachine)}</b>, всего <b>${plan.totalBelts} ${pluralBelts(
        plan.totalBelts
      )}</b> ${fullBeltBtn} <span class="inputResWarn">⚠ один завод ${warnVerb} больше, чем несёт целая лента (${plan.beltSpeed.toFixed(2)}/сек)</span></li>`;
    }
    if (plan.totalBelts <= 1) {
      return `<li>${start} <b>1 лента</b> <span class="hint">(заполнена на ${plan.lastFillPct.toFixed(0)}%)</span> ${fullBeltBtn}</li>`;
    }
    return `<li>${start} на 1 ленту — <b>${plan.machinesPerBelt}</b> ${pluralMachines(plan.machinesPerBelt)}, всего <b>${plan.totalBelts} ${pluralBelts(
      plan.totalBelts
    )}</b> <span class="hint">(последняя на ${plan.lastFillPct.toFixed(0)}%)</span> ${fullBeltBtn}</li>`;
  }

  // Every solid input a stage needs (recipe ingredients + fuel), keyed rate/sec.
  // Fluids/gases go by pipe and aren't part of belt/group math.
  // `root` defaults to the active tab, but the «Сводка» walks OTHER tabs, whose
  // nodes don't live in state.cascade - passing their own root keeps fuel and
  // the manual group size from silently vanishing there.
  function stageSolidInputs(n, root) {
    const out = {};
    for (const [k, v] of Object.entries(n.ingredients || {})) {
      if (k.startsWith("item:") && v > 0) out[k] = (out[k] || 0) + v;
    }
    const treeNode = findTreeNodeById(root || (state.cascade && state.cascade.root), n.id);
    const machine = (state.dataset.entities || {})[n.machineName];
    // Fluid fuel is piped, not belted - it shows up among the fluid lines instead
    // (see stageFluidInputs), so only solid fuel is added here.
    if (treeNode && machine && treeNode.fuelItem && fuelKind(machine) === "item") {
      const fuel = fuelEntry(state.dataset, machine, treeNode.fuelItem);
      const rate =
        fuelConsumptionPerMachine(machine, fuel, effectsWithMachineBase(treeNode, machine).consumption) * n.machines;
      if (rate > 1e-9) {
        const fk = itemKey("item", treeNode.fuelItem);
        out[fk] = (out[fk] || 0) + rate;
      }
    }
    return out;
  }

  /** Из чего складывается твёрдый вход этапа: рецепт и топка по отдельности.
   *
   *  У «Раскалённого кокса» уголь идёт И в рецепт, И в топку печи — это один и
   *  тот же ресурс, поэтому в потребность он попадает суммой, а тут видно, из
   *  чего сумма собрана.
   */
  function stageSolidInputSplit(n, root) {
    const split = {};
    const add = (key, part, rate) => {
      if (!(rate > 1e-9)) return;
      if (!split[key]) split[key] = { recipe: 0, fuel: 0 };
      split[key][part] += rate;
    };
    for (const [k, v] of Object.entries(n.ingredients || {})) if (k.startsWith("item:")) add(k, "recipe", v);
    const treeNode = findTreeNodeById(root || (state.cascade && state.cascade.root), n.id);
    const machine = (state.dataset.entities || {})[n.machineName];
    if (treeNode && machine && treeNode.fuelItem && fuelKind(machine) === "item") {
      const fuel = fuelEntry(state.dataset, machine, treeNode.fuelItem);
      const rate =
        fuelConsumptionPerMachine(machine, fuel, effectsWithMachineBase(treeNode, machine).consumption) * n.machines;
      add(itemKey("item", treeNode.fuelItem), "fuel", rate);
    }
    return split;
  }

  // Recipe fluids + the fuel fluid a gas-burning machine needs on the same pipes.
  function stageFluidInputs(n, root) {
    const out = {};
    for (const [k, v] of Object.entries(n.ingredients || {})) {
      if (k.startsWith("fluid:") && v > 0) out[k] = (out[k] || 0) + v;
    }
    const treeNode = findTreeNodeById(root || (state.cascade && state.cascade.root), n.id);
    const machine = (state.dataset.entities || {})[n.machineName];
    if (treeNode && machine && treeNode.fuelItem && fuelKind(machine) === "fluid") {
      const fuel = fuelEntry(state.dataset, machine, treeNode.fuelItem);
      const rate =
        fuelConsumptionPerMachine(machine, fuel, effectsWithMachineBase(treeNode, machine).consumption) * n.machines;
      if (rate > 1e-9) {
        const fk = itemKey("fluid", treeNode.fuelItem);
        out[fk] = (out[fk] || 0) + rate;
      }
    }
    return out;
  }

  // ---- INPUT feeding model ---------------------------------------------------
  // Two DIFFERENT partitions of the same machines, and mixing them up is what
  // produced the ugly "one group of 105, one group of 5" split:
  //
  //   * OUTPUT BLOCK - the machines that unload onto ONE output belt. Its size
  //     is capped by belt capacity (and by how many machines exist).
  //   * FEEDING GROUP - a block of machines with its own set of input belts.
  //     Groups NEST INSIDE an output block: several groups can happily unload
  //     onto the same output belt, so a small group never starves the output.
  //
  // Sizing a group: a resource's belt caps how many machines it can feed. Rather
  // than cramming groups to that cap and dumping the remainder into a runt group
  // (105 + 5), we take the number of groups the block needs - ceil(block / cap) -
  // and split the block EVENLY between them (55 + 55). Same belts, no skew.
  //
  // Two resources can also ride ONE belt, one on each edge (each edge carries
  // beltSpeed/2). That halves the belts but also halves how many machines a
  // resource can feed, so it usually means more (smaller) groups. We simply pick
  // whichever scheme needs the FEWEST BELTS on the whole stage: pairing wins when
  // 3 groups × 1 belt beats 2 groups × 2 belts, and loses when it would shatter
  // the stage into a swarm of tiny groups.

  // Split `total` into the fewest groups that respect `maxSize`, as evenly as
  // possible: 110 machines with a cap of 105 → 55 + 55, not 105 + 5.
  function balancedSplit(total, maxSize) {
    const count = Math.max(1, Math.ceil(total / Math.max(1, maxSize)));
    const base = Math.floor(total / count);
    const remainder = total % count; // this many groups get one extra machine
    const sizes = [];
    for (let i = 0; i < count; i++) sizes.push(base + (i < remainder ? 1 : 0));
    return { count, sizes, maxGroup: sizes[0], minGroup: sizes[sizes.length - 1] };
  }

  // То же, но `total` может быть дробным (7.5 завода) и `maxSize` — дробный
  // (лента на 7.5 завода). Число групп считается по ПОТОКУ: 7.5 завода на ленте
  // в 7.5 завода — это ОДНА группа, а не две. А вот размеры групп — целые
  // заводы (половину завода не построишь), поэтому 7.5 становятся группой из 8,
  // где последний завод недогружен.
  /** Максимум и минимум по массиву БЕЗ раскрытия в аргументы.
   *
   *  `Math.max(...sizes)` переполняет стек, когда групп становится много: у
   *  цепочки с сотнями миллионов заводов список размеров переваливает за
   *  предел числа аргументов, и весь план подачи падал с «Maximum call stack
   *  size exceeded» (видно было как «план подачи не посчитался»). Считаем
   *  циклом — работает на любом размере. */
  function arrayMax(arr, fallback = 0) {
    let best = fallback;
    for (let i = 0; i < arr.length; i++) if (arr[i] > best) best = arr[i];
    return best;
  }

  function arrayMin(arr, fallback = 0) {
    if (!arr.length) return fallback;
    let best = arr[0];
    for (let i = 1; i < arr.length; i++) if (arr[i] < best) best = arr[i];
    return best;
  }

  function balancedSplitFlow(total, maxSize) {
    const cap = maxSize > 0 ? maxSize : total;
    const physical = Math.max(1, Math.ceil(total - 1e-9));
    const count = Math.max(1, Math.ceil(total / cap - 1e-9));
    const base = Math.floor(physical / count);
    const remainder = physical % count;
    const sizes = [];
    for (let i = 0; i < count; i++) sizes.push(base + (i < remainder ? 1 : 0));
    return { count, sizes, maxGroup: arrayMax(sizes), minGroup: arrayMin(sizes) };
  }

  // A hand-typed group size is taken LITERALLY: type 52 and you get groups of
  // 52, with whatever is left over in a final short group (52 + 52 + 6). You
  // asked for that number, so that's the number you get - we just point out
  // which number would have come out even.
  function exactSplit(total, size) {
    const sizes = [];
    let left = total;
    while (left > size) {
      sizes.push(size);
      left -= size;
    }
    sizes.push(left);
    return { count: sizes.length, sizes, maxGroup: arrayMax(sizes), minGroup: arrayMin(sizes) };
  }

  // Разбиение на заданное число ГРУПП: блоки выхода остаются отдельными (в блоке групп не меньше одной), оставшиеся
  // группы достаются блокам с самым большим числом заводов на группу; внутри блока заводы делятся ровно.
  function splitByCount(blockSizes, groups) {
    const physical = blockSizes.map((b) => Math.max(1, Math.ceil(b - 1e-9)));
    const counts = physical.map(() => 1);
    let left = Math.max(0, groups - counts.length);
    while (left > 0) {
      let best = -1;
      let bestLoad = -1;
      physical.forEach((m, i) => {
        if (counts[i] >= m) return;                       // групп не больше, чем заводов в блоке
        const load = m / counts[i];
        if (load > bestLoad) {
          best = i;
          bestLoad = load;
        }
      });
      if (best < 0) break;
      counts[best] += 1;
      left -= 1;
    }
    return physical.map((m, i) => {
      const base = Math.floor(m / counts[i]);
      const remainder = m % counts[i];
      const sizes = [];
      for (let k = 0; k < counts[i]; k++) sizes.push(base + (k < remainder ? 1 : 0));
      return { count: sizes.length, sizes, maxGroup: arrayMax(sizes), minGroup: arrayMin(sizes) };
    });
  }

  function computeFeedPlan(n, root) {
    const cascadeRoot = root || (state.cascade && state.cascade.root);
    if (!n || !n.machines) return null;
    const beltSpeed = state.belt.speed;
    const laneSpeed = beltSpeed / 2;
    if (!(beltSpeed > 0)) return null;

    const solids = stageSolidInputs(n, cascadeRoot);
    const keys = Object.keys(solids).filter((k) => solids[k] > 0);

    const totalMachines = Math.max(1, Math.ceil(n.machines - 1e-9));
    const perMachine = {};
    for (const k of keys) perMachine[k] = solids[k] / n.machines;
    const treeNodeHere = findTreeNodeById(cascadeRoot, n.id);
    // Ресурсы, пущенные своей лентой (кнопка «Полная лента этого ресурса»): схема, где
    // такой ресурс делит ленту с соседом, не рассматривается — пара разбивается, остальные
    // ресурсы пересобираются между собой. Выбор хранится в цепочке и переживает
    // сохранение и загрузку.
    const forcedSolo = new Set(
      (Array.isArray(treeNodeHere && treeNodeHere.soloFeedKeys) ? treeNodeHere.soloFeedKeys : [])
        .filter((k) => keys.includes(k))
    );

    // The output side is needed for the explanation ("выход уходит на N лент") and
    // for «Приоритет — выход», where the output blocks DO cut the feeding groups.
    // Пепел считается частью выхода, если так решил человек (см. ashToggle).
    const outPlan = computeCombinedOutputPlan(combinedOutputItems(n), n.machines);
    const usesOutputBelt = !!outPlan && !outPlan.oneMachineNeedsMultipleBelts;
    // Твёрдых входов нет (всё по трубам), но продукт едет лентой: группы режет один только выход — сколько заводов
    // выгружает на одну ленту. Без ленты выхода групп нет вовсе.
    if (!keys.length && !usesOutputBelt) return null;
    const priorityNode = findTreeNodeById(cascadeRoot, n.id);
    // Приоритет всегда «выход»: подача режется по блокам выгрузки, чтобы каждый блок
    // получал полную ленту.
    const alignPriority = usesOutputBelt ? "out" : null;

    // By default the output belt does NOT cut the feeding groups: how many input
    // belts a stage needs is a question about the FLOW it eats (15/сек per belt),
    // not about how the products happen to leave - one input belt can run along
    // several output blocks. The block being split is then the whole stage, and it
    // stays FRACTIONAL (7.5 machines eat exactly one belt → ONE group). With
    // «Приоритет — выход» the person asks for the other alignment: one output
    // block = its own feeding group(s).
    const blockSizes = [];
    if (usesOutputBelt && alignPriority === "out") {
      for (let i = 0; i < outPlan.blocks - 1; i++) blockSizes.push(outPlan.machinesPerBelt);
      // Последний блок — остаток ПОТОКА, а не целых заводов: ёмкость группы ниже тоже в потоке
      // (дробная), и целая единица, поделённая на дробную ёмкость 0.2, давала «1 + 4 × 0».
      blockSizes.push(Math.max(1e-9, n.machines - (outPlan.blocks - 1) * outPlan.machinesPerBelt));
    } else {
      blockSizes.push(n.machines);
    }

    // How many machines ONE belt serves — «как есть»: capacity / perMachine, without
    // rounding. 7.5 means "7 fully and one at half", and that is what gets written.
    const maxSolo = (k) => (perMachine[k] > 0 ? machinesPerBelt(perMachine[k], beltSpeed) : 0);
    const maxLane = (k) => (perMachine[k] > 0 ? machinesPerBelt(perMachine[k], laneSpeed) : 0);

    // Lightest eaters first - they're the ones that can live on half a belt.
    const sorted = keys.slice().sort((a, b) => perMachine[a] - perMachine[b]);

    // Candidate schemes: k = how many resources ride shared belts (2 per belt,
    // one on each edge). k=0 → everyone gets their own belt; k=2 → one shared
    // belt; k=4 → two shared belts; and so on.
    const candidates = [];
    for (let k = 0; k <= sorted.length; k += 2) {
      const laneKeys = sorted.slice(0, k);
      if (laneKeys.some((key) => maxLane(key) < 1)) break; // can't survive on half a belt
      // «Полная лента этого ресурса»: он едет своей лентой, делить её нельзя.
      if (laneKeys.some((key) => forcedSolo.has(key))) continue;
      const soloKeys = sorted.slice(k);

      // How many machines one group can be fed, under this scheme. This is a FLOW
      // figure and stays fractional ("7.5 завода"), because it is what decides the
      // number of belts: a stage of 7.5 machines is one belt's worth.
      let cap = n.machines;
      for (const key of laneKeys) cap = Math.min(cap, maxLane(key));
      for (const key of soloKeys) cap = Math.min(cap, maxSolo(key) >= 1 ? maxSolo(key) : 1);
      cap = Math.max(1e-9, cap);

      const beltsPerGroup =
        k / 2 + soloKeys.reduce((sum, key) => sum + (maxSolo(key) >= 1 ? 1 : Math.ceil(perMachine[key] / beltSpeed - 1e-9)), 0);

      // Each output block is split into as few groups as the flow allows.
      const splits = blockSizes.map((b) => balancedSplitFlow(b, cap));
      const numGroups = splits.reduce((s, sp) => s + sp.count, 0);
      const groupSizes = splits.flatMap((sp) => sp.sizes);
      const maxGroup = arrayMax(groupSizes);
      const minGroup = arrayMin(groupSizes);

      candidates.push({
        pairedCount: k,
        laneKeys,
        soloKeys,
        cap,
        beltsPerGroup,
        splits,
        numGroups,
        groupSizes,
        maxGroup,
        minGroup,
        skew: maxGroup - minGroup,
        totalBelts: beltsPerGroup * numGroups,
      });
    }

    // A manual group size, typed into the card and stored on the chain node (so
    // it survives save/load). It caps the group instead of the automatic limit;
    // an empty field means "back to automatic".
    const treeNodeForOverride = treeNodeHere;
    const sizeOverride = treeNodeForOverride && treeNodeForOverride.feedGroupSize > 0 ? Math.floor(treeNodeForOverride.feedGroupSize) : null;
    // Число групп задают вместо размера (поля не работают вместе: ввод одного очищает другое).
    const groupsWanted =
      !sizeOverride && treeNodeForOverride && treeNodeForOverride.feedGroupCount > 0
        ? Math.floor(treeNodeForOverride.feedGroupCount)
        : null;
    const groupsCapped = groupsWanted ? Math.min(groupsWanted, totalMachines) : null;
    // Для проверки «накормит ли лента» нужен самый большой размер группы при таком числе групп
    const override = sizeOverride || (groupsCapped ? Math.ceil(totalMachines / groupsCapped) : null);

    // With a manual size, only schemes whose belts can actually feed that many
    // machines are on the table. If the number is bigger than ANY scheme can
    // feed, we keep the best we can and say so instead of quietly lying.
    let pool = candidates;
    let overrideTooBig = false;
    if (override) {
      // The typed number is whole MACHINES, and a group of N machines fits as long
      // as all but the last one run flat out: N-1 <= cap (the last one takes
      // whatever is left). So a belt that carries 7.5 machines' worth has room for
      // a group of 8 (the 8th being throttled).
      const fits = (cap, n) => maxGroupPhysical(cap) >= n;
      const feasible = candidates.filter((c) => fits(c.cap, override));
      if (feasible.length) {
        pool = feasible;
      } else {
        overrideTooBig = true;
        const bestCap = Math.max(...candidates.map((c) => c.cap));
        pool = candidates.filter((c) => c.cap === bestCap);
      }
      // Re-split the blocks using the requested size, LITERALLY. (Unless the
      // number is unfeedable - then it tells us nothing, so we fall back to the
      // even split rather than inventing a skewed one.)
      for (const c of pool) {
        const size = Math.max(1, Math.min(override, maxGroupPhysical(c.cap)));
        c.splits = overrideTooBig
          ? blockSizes.map((b) => balancedSplitFlow(b, c.cap))
          : groupsCapped
          ? splitByCount(blockSizes, groupsCapped)
          : blockSizes.map((b) => exactSplit(Math.max(1, Math.ceil(b - 1e-9)), size));
        c.numGroups = c.splits.reduce((s, sp) => s + sp.count, 0);
        c.groupSizes = c.splits.flatMap((sp) => sp.sizes);
        c.maxGroup = arrayMax(c.groupSizes);
        c.minGroup = arrayMin(c.groupSizes);
        c.skew = c.maxGroup - c.minGroup;
        c.totalBelts = c.beltsPerGroup * c.numGroups;
      }
    }

    // Fewest belts on the whole stage wins - but not at any price. A scheme that
    // saves a belt or two by shattering the stage into a swarm of one-machine
    // groups is a worse factory, not a better one. So: take the belt-cheapest
    // scheme, allow anything within BELT_SLACK of it, and among those prefer the
    // one with the FEWEST groups (then the least skew, then bigger groups).
    const BELT_SLACK = 1.1; // up to 10% more belts is worth it to halve the group count
    const minBelts = Math.min(...pool.map((c) => c.totalBelts));
    const affordable = pool.filter((c) => c.totalBelts <= minBelts * BELT_SLACK + 1e-9);
    const ranked = affordable
      .slice()
      .sort((a, b) => a.numGroups - b.numGroups || a.totalBelts - b.totalBelts || a.skew - b.skew || b.maxGroup - a.maxGroup);
    const chosen = ranked[0];
    const runnerUp = candidates.filter((c) => c.pairedCount !== chosen.pairedCount).sort((a, b) => a.totalBelts - b.totalBelts)[0] || null;

    const pairs = [];
    for (let i = 0; i + 1 < chosen.laneKeys.length; i += 2) pairs.push([chosen.laneKeys[i], chosen.laneKeys[i + 1]]);

    const treeNode = treeNodeHere;
    const fuelKey = treeNode && treeNode.fuelItem ? itemKey("item", treeNode.fuelItem) : null;

    // Rates are quoted for the BIGGEST group (the worst case for a belt).
    const sizeForRates = chosen.maxGroup;
    const stageSplit = stageSolidInputSplit(n, cascadeRoot);
    const info = {};
    for (const key of keys) {
      const pm = perMachine[key];
      // What the belt will really CARRY for that group is its share of the stage's
      // demand: solids[key] x groupSize / builtMachines. `pm * sizeForRates` looks
      // like the same thing but it is the group running FLAT OUT, which only equals
      // the demand when the stage's machine count happens to be a whole number. On
      // a stage that needs 0.5 of a machine those differed by 2x, which is why the
      // same resource read "0.67/сек" in the raw-input list and "1.33/сек на
      // группу" on the stage card. Capacity questions ("одна лента кормит до N
      // заводов") still use the flat-out per-machine rate.
      const perGroupDemand = totalMachines > 0 ? (solids[key] * sizeForRates) / totalMachines : 0;
      const perGroupFlatOut = pm * sizeForRates;
      const shared = chosen.laneKeys.includes(key);
      // «Как есть»: лента (или её сторона) обслуживает capacity/pm заводов, и это
      // число остаётся дробным — именно его и печатаем.
      const capacity = shared ? laneSpeed : beltSpeed;
      const machinesPerBeltHere = machinesPerBelt(pm, capacity);
      // Лента не может нести больше своей ёмкости: если из-за целых заводов в
      // группе их «просят» больше, реально группа получит ровно ленту, а
      // последний завод встанет недогруженным.
      const perGroup = Math.min(perGroupDemand, capacity);
      // Если в группе больше заводов, чем лента кормит на полную, последний
      // завод недогружен: ему достаётся остаток ленты после всех остальных.
      const throttled = machinesPerBeltHere >= 1 && sizeForRates > machinesPerBeltHere + 1e-9;
      const lastMachinePct = throttled
        ? Math.max(0, Math.min(100, ((capacity - (sizeForRates - 1) * pm) / pm) * 100))
        : null;
      info[key] = {
        key,
        rate: solids[key],
        perMachine: pm,
        perGroup,
        perGroupDemand,
        perGroupFlatOut,
        shared,
        impossible: maxSolo(key) < 1, // one machine eats more than a whole belt
        beltsPerMachine: maxSolo(key) >= 1 ? 1 : Math.ceil(pm / beltSpeed - 1e-9),
        lanePct: Math.min(100, (perGroup * 100) / laneSpeed), // fill of its edge on a shared belt
        beltPct: Math.min(100, (perGroup * 100) / beltSpeed), // fill of its own belt
        machinesPerBelt: machinesPerBeltHere,
        machinesPerLane: maxLane(key),
        groupMachines: sizeForRates,
        lastMachinePct,
        throttled,
        // «в рецепт X + в топку Y» для ЭТОЙ группы: доли берём из разбивки этапа,
        // а сумму — ту, что стоит в строке («на группу»), чтобы X + Y = «на группу».
        splitPerGroup: (() => {
          const split = stageSplit[key];
          if (!split) return null;
          const total = split.recipe + split.fuel;
          if (!(total > 1e-9) || !(perGroup > 0)) return null;
          return { recipe: (perGroup * split.recipe) / total, fuel: (perGroup * split.fuel) / total };
        })(),
      };
    }

    // Human-readable group sizes: "37 + 37 + 36" or "55 × 2".
    const sizeCounts = new Map();
    for (const s of chosen.groupSizes) sizeCounts.set(s, (sizeCounts.get(s) || 0) + 1);
    const sizeSummary = [...sizeCounts.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([size, count]) => (count > 1 ? `${count} × ${size}` : `${size}`))
      .join(" + ");

    return {
      beltSpeed,
      laneSpeed,
      totalMachines,
      cap: chosen.cap,
      numGroups: chosen.numGroups,
      groupSizes: chosen.groupSizes,
      maxGroup: chosen.maxGroup,
      minGroup: chosen.minGroup,
      sizeSummary,
      pairs,
      soloKeys: chosen.soloKeys,
      // Ресурсы, пущенные своей лентой (см. forcedSolo выше).
      forcedSoloKeys: [...forcedSolo],
      beltsPerGroup: chosen.beltsPerGroup,
      totalBelts: chosen.totalBelts,
      info,
      fuelKey,
      usesOutputBelt,
      blockSizes,
      // Из чего складывается каждый твёрдый вход: рецепт и топка (см. feedRecipeFuelSplitHTML).
      inputSplit: stageSolidInputSplit(n, cascadeRoot),
      outBlockMachines: usesOutputBelt ? outPlan.blockMachines : null,
      outBlocks: usesOutputBelt ? outPlan.blocks : null,
      override: sizeOverride,
      overrideGroups: groupsWanted,
      overrideGroupsCapped: groupsCapped,
      overrideTooBig,
      alignPriority,
      // Biggest group any scheme could feed — in whole machines (see maxGroupPhysical).
      autoCap: Math.max(...candidates.map((c) => maxGroupPhysical(c.cap))),
      autoCapFlow: Math.max(...candidates.map((c) => c.cap)),
      // If the manual size left a runt group, this is the size that comes out even.
      evenSuggestion:
        sizeOverride && chosen.skew > 0
          ? balancedSplitFlow(blockSizes[0], chosen.cap).maxGroup
          : null,
      runnerUp: runnerUp
        ? { pairedCount: runnerUp.pairedCount, numGroups: runnerUp.numGroups, totalBelts: runnerUp.totalBelts, maxGroup: runnerUp.maxGroup }
        : null,
      hasSolids: keys.length > 0,
    };
  }

  // ---- «Сводка» stage detail -----------------------------------------------
  // Facts only: how many machines, how they split into feeding groups, which
  // resources ride a belt TOGETHER and which get their own, and how the output
  // leaves. No rates, no percentages, no fill bars - those live on the stage
  // cards; the summary is a build list.
  function feedSummaryHTML(n, root) {
    const p = computeFeedPlan(n, root);
    if (!p) return `<div class="sumLine"><span class="sumTag">подача</span>только жидкости — по трубам</div>`;

    const sizes =
      p.numGroups <= 1
        ? `<b>1 группа</b> — все ${p.maxGroup} ${pluralMachines(p.maxGroup)}`
        : p.minGroup === p.maxGroup
        ? `<b>${p.numGroups} ${pluralGroups(p.numGroups)}</b> по <b>${p.maxGroup}</b> ${pluralMachines(p.maxGroup)}`
        : `<b>${p.numGroups} ${pluralGroups(p.numGroups)}</b>: ${p.sizeSummary} ${pluralMachines(p.maxGroup)}${sizeLegend(p.sizeSummary)}`;
    const manual = p.override || p.overrideGroups ? ` <span class="sumManual">вручную</span>` : "";

    // Who rides with whom - the one thing the summary must make obvious.
    const beltRows = [];
    for (const [a, b] of p.pairs) {
      beltRows.push(
        `<div class="sumBeltRow shared">${iconImg(keyIconUrl(state.dataset, a), 14)}${keyDisplayName(state.dataset, a)} <span class="sumPlus">+</span> ${iconImg(
          keyIconUrl(state.dataset, b),
          14
        )}${keyDisplayName(state.dataset, b)} — <b>вместе, 1 лента</b></div>`
      );
    }
    for (const key of p.soloKeys) {
      const i = p.info[key];
      const fuel = key === p.fuelKey ? ` <span class="hint">(топливо)</span>` : "";
      beltRows.push(
        i.impossible
          ? `<div class="sumBeltRow warnRow">${iconImg(keyIconUrl(state.dataset, key), 14)}${keyDisplayName(state.dataset, key)}${fuel} — ⚠ ${
              i.beltsPerMachine
            } ${pluralBelts(i.beltsPerMachine)} на каждый завод</div>`
          : `<div class="sumBeltRow">${iconImg(keyIconUrl(state.dataset, key), 14)}${keyDisplayName(
              state.dataset,
              key
            )}${fuel} — <b>отдельно</b></div>`
      );
    }

    if (!p.hasSolids) {
      return (
        `<div class="sumLine"><span class="sumTag">группы</span>${sizes}${manual}</div>` +
        `<div class="sumLine"><span class="sumTag">подача</span>только жидкости — по трубам</div>`
      );
    }
    return (
      `<div class="sumLine"><span class="sumTag">группы</span>${sizes}${manual}</div>` +
      `<div class="sumLine"><span class="sumTag">подача</span><b>${p.beltsPerGroup} ${pluralBelts(p.beltsPerGroup)}</b> на группу, <b>${
        p.totalBelts
      } ${pluralBelts(p.totalBelts)}</b> на этап</div>` +
      `<div class="sumBelts">${beltRows.join("")}</div>`
    );
  }

  // The output side: how many belts to lay, and (if several products share the
  // belt) which ones ride it together.
  function outputSummaryHTML(n) {
    const plan = computeCombinedOutputPlan(combinedOutputItems(n), n.machines);
    if (!plan) return "";
    let head;
    if (plan.oneMachineNeedsMultipleBelts) {
      const belts = plan.totalMachines * plan.beltsPerMachine;
      head = `⚠ <b>${belts} ${pluralBelts(belts)}</b> — завод выдаёт больше целой ленты`;
    } else if (plan.blocks <= 1) {
      head = `<b>1 лента</b> на все ${plan.totalMachines} ${pluralMachines(plan.totalMachines)}`;
    } else {
      head = `<b>${plan.blocks} ${pluralBlocks(plan.blocks)}</b> по ${plan.machinesPerBelt} ${pluralMachines(plan.machinesPerBelt)} — по 1 ленте на блок`;
    }
    const together =
      plan.parts.length > 1
        ? `<div class="sumBelts"><div class="sumBeltRow shared">${plan.parts
            .map((part) => `${iconImg(keyIconUrl(state.dataset, part.key), 14)}${keyDisplayName(state.dataset, part.key)}`)
            .join(' <span class="sumPlus">+</span> ')} — <b>вместе, одной лентой</b></div></div>`
        : "";
    return `<div class="sumLine"><span class="sumTag">выгрузка</span>${head}</div>${together}`;
  }

  // Все твёрдые входы этапа (ингредиенты рецепта + топливо), ключ → расход в секунду.
  // Жидкости и газы идут трубами и в расчёт лент и групп не входят.
  // ---- модель выходной ленты (общая) ----------------------------------------
  // Весь твёрдый выход этапа едет ОДНОЙ лентой как один смешанный поток: он не делится ни
  // по ресурсам, ни по полосам. Размер считается по потоку: сумма расходов всех продуктов,
  // сколько заводов этого суммарного потока несёт одна полная лента (округление вниз) —
  // это «блок»: группа заводов, выгружающая на одну полную ленту. Этап — M таких блоков
  // (последний обычно неполный).
  // Пепел (результат сгорания топлива) в этот поток не входит: у него отдельная строка,
  // он выходит из отдельного слота.
  //
  // Поток можно разложить по обеим полосам, поэтому потолок — скорость самой ленты. Если
  // каждый завод выгружает в одну полосу, полосы делятся неровно и одна переполняется;
  // об этом карточке говорит `laneOverflow` в плане.
  //
  // Отдельный ресурс (своя линия продукта, пепел, пара по краям) считается по полосе:
  // beltIdealMachines / computeBeltPlan(..., "out").

  function computeCombinedOutputPlan(itemsMap, exactMachines) {
    const solids = Object.entries(itemsMap || {}).filter(([k, v]) => k.startsWith("item:") && v > 0);
    if (!solids.length || !exactMachines || exactMachines <= 0) return null;
    const beltSpeed = state.belt.speed;
    if (!(beltSpeed > 0)) return null;

    const totalRate = solids.reduce((s, [, v]) => s + v, 0);
    if (!(totalRate > 0)) return null;
    const perMachineTotal = totalRate / exactMachines; // combined output of ONE machine
    const totalMachines = Math.max(1, Math.ceil(exactMachines - 1e-9));

    // Ёмкость ленты для суммарного выхода этапа: весь твёрдый выход едет одной лентой как
    // один поток, лента несёт beltSpeed в секунду — это потолок. Полосы — раскладка, а не
    // потолок: поток раскладывается по обеим.
    //
    // Пример: Крахмал 8/3 на завод = 2.67/сек, 15 / 2.67 = 5.6 → 5 заводов = 13.33/сек.
    const machinesPerBelt = Math.floor(beltSpeed / perMachineTotal + 1e-9);
    const oneMachineNeedsMultipleBelts = machinesPerBelt < 1;
    const beltsPerMachine = oneMachineNeedsMultipleBelts ? Math.ceil(perMachineTotal / beltSpeed - 1e-9) : 1;

    const perBlock = Math.max(1, machinesPerBelt);
    const blocks = oneMachineNeedsMultipleBelts ? totalMachines : Math.ceil(totalMachines / perBlock);
    const lastBlockMachines = oneMachineNeedsMultipleBelts ? 1 : totalMachines - (blocks - 1) * perBlock;

    // The block we actually describe: if everything fits on one belt there is
    // no "full block" - there's just the machines you have.
    const blockMachines = blocks <= 1 ? totalMachines : perBlock;

    // What the belt will actually CARRY is the required flow spread over the
    // machines that get BUILT, not "every built machine running flat out". Those
    // differ whenever the required machine count is fractional (0.8 of a machine
    // is built as 1), and mixing the two made one sentence read "Общий поток
    // 1.00/сек … заполнена на 8%" (1.00/15 = 6.7%). Capacity statements
    // ("влезло бы N заводов") keep the flat-out rate - that is a question about
    // the belt, not about the duty cycle.
    const demandShare = (machines) => (totalMachines > 0 ? (totalRate * machines) / totalMachines : 0);
    const pctOfBelt = (rate) => Math.min(100, (rate * 100) / beltSpeed);
    const fullBlockPct = pctOfBelt(demandShare(perBlock));
    const lastBlockPct = pctOfBelt(demandShare(lastBlockMachines));
    const blockCapacityPct = pctOfBelt(perBlock * perMachineTotal);

    // Per-resource share of the belt inside that block, plus its share of the
    // mixed stream itself. Together the resources add up to the belt's fill.
    const parts = solids.map(([key, rate]) => {
      const perMachine = rate / exactMachines;
      return {
        key,
        rate,
        perMachine,
        beltPct: pctOfBelt(demandShare(blockMachines) * (rate / totalRate)), // % of the belt it takes in a block
        lastPct: pctOfBelt(demandShare(lastBlockMachines) * (rate / totalRate)), // ... in the last block
        streamPct: (rate * 100) / totalRate, // % of the mixed stream
      };
    });

    // Полосы у ленты две, и если каждый завод ссыпает свой поток в ОДНУ полосу,
    // они делятся как ceil(N/2) и floor(N/2). Когда на полосу приходит больше,
    // чем она несёт, поток придётся разложить по обеим (манипулятор на каждую
    // полосу или слияние полос) — об этом говорим прямо, а не молчим: иначе
    // обещание «на полную ленту влезет 5 заводов» окажется неправдой.
    const laneSpeed = beltSpeed / 2;
    const laneMachines = Math.ceil(perBlock / 2);
    const laneRate = laneMachines * perMachineTotal;
    const laneOverflow = !oneMachineNeedsMultipleBelts && laneRate > laneSpeed + 1e-9
      ? { machines: laneMachines, rate: laneRate, laneSpeed }
      : null;

    return {
      beltSpeed,
      keys: solids.map(([k]) => k),
      parts,
      totalRate,
      perMachineTotal,
      totalMachines,
      machinesPerBelt: perBlock,
      blockMachines,
      blocks,
      lastBlockMachines,
      fullBlockPct,
      lastBlockPct,
      blockCapacityPct,
      oneMachineNeedsMultipleBelts,
      beltsPerMachine,
      laneOverflow,
    };
  }

  // Already a perfect single full belt → the «Полная лента» button is a no-op.
  function combinedOutputIsFullBelt(plan) {
    return !!plan && !plan.oneMachineNeedsMultipleBelts && plan.blocks === 1 && plan.totalMachines === plan.machinesPerBelt;
  }

  // The headline of the output section. IMPORTANT: it leads with the machines
  // the stage ACTUALLY has - the "how many fit on a full belt" number is belt
  // CAPACITY, not a build order, and reading it as "you need 131 machines" was
  // exactly the confusion this wording avoids.
  /** Как выходные блоки ложатся на КОРМЯЩИЕ ГРУППЫ этапа.
   *
   *  Вход режется на группы по ёмкости ленты подачи (у «Цинковой плиты» — 15
   *  групп по 10–11 заводов), а выход — по ёмкости ленты выгрузки (54 завода на
   *  ленту). Человек строит группы входа как блоки, и ему нужно знать, сколько
   *  групп укладывается в одну выходную ленту и какие группы при этом режутся:
   *  иначе приходится считать самому. Отсюда и раскладка ниже. */
  function outputGroupSplit(plan, groupSizes) {
    if (!plan || !groupSizes || groupSizes.length < 2) return null;
    const total = groupSizes.reduce((s, v) => s + v, 0);
    if (Math.abs(total - plan.totalMachines) > 1e-6) return null; // группы не про этот этап
    const blocks = [];
    let index = 0;
    let leftInGroup = groupSizes[0] || 0;
    for (let b = 0; b < plan.blocks; b += 1) {
      const size = b === plan.blocks - 1 ? plan.lastBlockMachines : plan.machinesPerBelt;
      let left = size;
      const parts = [];
      while (left > 0 && index < groupSizes.length) {
        const take = Math.min(left, leftInGroup);
        parts.push({ group: index + 1, take, of: groupSizes[index], whole: take === groupSizes[index] });
        left -= take;
        leftInGroup -= take;
        if (leftInGroup <= 0) {
          index += 1;
          leftInGroup = groupSizes[index] || 0;
        }
      }
      blocks.push({ size, parts });
    }
    return blocks;
  }

  /** «группы 1–4 + 10/11 группы 5» — короткая запись, без простыни. */
  function outputGroupPartsText(parts) {
    const ranges = [];
    const partial = [];
    let start = null;
    let prev = null;
    for (const p of parts) {
      if (p.whole) {
        if (start === null) start = p.group;
        else if (p.group !== prev + 1) {
          ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
          start = p.group;
        }
        prev = p.group;
      } else {
        if (start !== null) {
          ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
          start = null;
        }
        partial.push(`${p.take}/${p.of} группы ${p.group}`);
      }
    }
    if (start !== null) ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    return [ranges.length ? `группы ${ranges.join(", ")}` : "", partial.join(" + ")].filter(Boolean).join(" + ");
  }

  /** Строка «одна выходная лента = сколько групп подачи» под блоком выхода.
   *
   *  Здесь и ответ на вопрос «сколько групп подачи везёт одна лента выхода»: если
   *  границы блоков совпали с группами — так и написано, если какая-то группа
   *  разрезана — это тоже сказано, а не спрятано. */
  function outputFeedGroupsHTML(nodeId, plan) {
    const feedPlan = stageFeedPlanFor(nodeId);
    if (!feedPlan) return "";
    const split = outputGroupSplit(plan, feedPlan.groupSizes);
    if (!split) return "";
    const perBelt = split[0];
    const aligned = split.every((b) => b.parts.every((p) => p.whole));
    const cut = split.reduce((n, b) => n + b.parts.filter((p) => !p.whole).length, 0);
    const head = aligned
      ? `границы лент совпадают с группами подачи — по ${perBelt.parts.length} ${pluralGroups(perBelt.parts.length)} на ленту`
      : `границы лент режут группы подачи (${cut} ${pluralGroups(cut)} попадает в две ленты) — группы придётся разносить`;
    const rows = split
      .map(
        (b, i) =>
          `<div class="beltFeedGroupRow">лента ${i + 1} (${b.size} ${pluralMachines(b.size)}): ${outputGroupPartsText(b.parts)}</div>`
      )
      .join("");
    return `<div class="beltFeedGroups"><span class="beltFeedGroupsHead">Одна лента выхода = <b>${perBelt.size}</b> ${pluralMachines(
      perBelt.size
    )} — ${head}</span>${rows}</div>`;
  }

  function combinedOutputNoteHTML(plan, nodeId) {
    if (plan.oneMachineNeedsMultipleBelts) {
      const belts = plan.totalMachines * plan.beltsPerMachine;
      return `<div class="beltGroupNote warn">⚠ один завод выдаёт больше, чем несёт целая лента (${plan.beltSpeed.toFixed(
        2
      )}/сек) — на каждый завод нужно <b>${plan.beltsPerMachine} ${pluralBelts(plan.beltsPerMachine)}</b>, на все ${plan.totalMachines} ${pluralMachines(
        plan.totalMachines
      )} — <b>${belts} ${pluralBelts(belts)}</b>.</div>`;
    }
    const capacityNote = `<span class="hint">(на полную ленту влезло бы ${plan.machinesPerBelt} ${pluralMachines(
      plan.machinesPerBelt
    )} — это ёмкость ленты, а не сколько строить)</span>`;
    // Лента несёт поток, но у неё две полосы: если каждый завод ссыпает своё в
    // одну полосу, полосы делятся неровно и одна переполняется. Говорим об этом
    // там, где обещаем «влезет N заводов» — иначе обещание было бы неправдой.
    const laneNote = plan.laneOverflow
      ? `<span class="hint">Полосы придётся уровнять: если каждый завод выгружает в свою полосу, на одну придёт ${plan.laneOverflow.rate.toFixed(
          2
        )}/сек из ${plan.laneOverflow.laneSpeed} — нужен манипулятор на каждую полосу или слияние полос.</span>`
      : "";

    // Everything fits on one belt: the only number that matters is "all of them".
    if (plan.blocks <= 1) {
      const short = plan.totalMachines < plan.machinesPerBelt;
      return `<div class="beltGroupNote">Все <b>${plan.totalMachines}</b> ${pluralMachines(
        plan.totalMachines
      )} выгружают на <b>1 ленту</b> — она заполнена на <b>${plan.lastBlockPct.toFixed(0)}%</b>. Общий поток ${plan.totalRate.toFixed(2)}/сек. ${
        short ? capacityNote : ""
      }${laneNote ? " " + laneNote : ""}</div>`;
    }
    // Blocks are counted correctly (10 machines at 8 per belt = one full block and
    // a remainder of 2), but the sentence said "делятся на 2 блока ПО 8 заводов",
    // which reads as 16 machines. So we spell out the actual split: 8 + 2.
    const lastIsFull = plan.lastBlockMachines === plan.machinesPerBelt;
    const fullBlocks = lastIsFull ? plan.blocks : Math.max(0, plan.blocks - 1);
    const sizes =
      fullBlocks > 2
        ? `${fullBlocks} × ${plan.machinesPerBelt}${lastIsFull ? "" : ` + ${plan.lastBlockMachines}`}`
        : [
            ...Array(fullBlocks).fill(plan.machinesPerBelt),
            ...(lastIsFull ? [] : [plan.lastBlockMachines]),
          ].join(" + ");
    const lastNote = lastIsFull
      ? ""
      : ` Лента последнего блока (${plan.lastBlockMachines} ${pluralMachines(
          plan.lastBlockMachines
        )}) заполнена на ${plan.lastBlockPct.toFixed(0)}%.`;
    const groupsNote = nodeId ? outputFeedGroupsHTML(nodeId, plan) : "";
    const sizesLegend = sizes.includes("×") ? ` <span class="hint">(блоков × заводов в блоке)</span>` : "";
    return `<div class="beltGroupNote">Твои <b>${plan.totalMachines}</b> ${pluralMachines(
      plan.totalMachines
    )} делятся на <b>${plan.blocks}</b> ${pluralBlocks(plan.blocks)} — по лентам: <b>${sizes}</b>${sizesLegend}. На одну ленту влезает <b>${
      plan.machinesPerBelt
    }</b> ${pluralMachines(plan.machinesPerBelt)} (весь поток этапа, округляя вниз).${lastNote} Общий поток ${plan.totalRate.toFixed(
      2
    )}/сек.${laneNote ? " " + laneNote : ""}${groupsNote}</div>`;
  }

  /** Пояснение к записи «4 × 7 + 5»: слева число групп, справа заводов в каждой. */
  function sizeLegend(summary) {
    return String(summary || "").includes("×") ? ` <span class="hint">(групп × заводов в группе)</span>` : "";
  }

  function pluralBlocks(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "блок";
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "блока";
    return "блоков";
  }

  // ---- пепел от сжигания топлива -------------------------------------------
  // Печь жжёт уголь и оставляет пепел. По умолчанию пепел уезжает СВОЕЙ лентой
  // (он и приходит с другого выхода завода), но его можно считать и вместе с
  // основным выходом — тогда он входит в тот же поток и в те же ленты. Это
  // переключатель «Пепел: отдельно / вместе с выходом» у заголовка «Выход».
  function stageAshInfo(n, treeNode, machine) {
    if (!n || !treeNode || !machine) return null;
    if (!compatibleFuels(state.dataset, machine).length) return null;
    if (fuelKind(machine) === "fluid" || !treeNode.fuelItem) return null;
    const fuelItem = fuelEntry(state.dataset, machine, treeNode.fuelItem);
    if (!fuelItem || !fuelItem.burnt_result) return null;
    const rate =
      fuelConsumptionPerMachine(machine, fuelItem, effectsWithMachineBase(treeNode, machine).consumption) * n.machines;
    if (!(rate > 1e-9)) return null;
    return { key: itemKey("item", fuelItem.burnt_result), rate };
  }

  function stageAshInfoFor(n, root) {
    const treeNode = findTreeNodeById(root || (state.cascade && state.cascade.root), n && n.id);
    const machine = (state.dataset && state.dataset.entities) || {};
    return stageAshInfo(n, treeNode, machine[n && n.machineName]);
  }

  function ashWithOutputEnabled(n) {
    const treeNode = findTreeNodeById(state.cascade && state.cascade.root, n && n.id);
    return !!(treeNode && treeNode.ashWithOutput);
  }

  /** Что реально едет на выходных лентах этапа: продукты, а с включённым
   *  переключателем — ещё и пепел от топлива. */
  function combinedOutputItems(n) {
    const items = { ...((n && n.products) || {}) };
    if (ashWithOutputEnabled(n)) {
      const ash = stageAshInfoFor(n);
      if (ash) items[ash.key] = (items[ash.key] || 0) + ash.rate;
    }
    return items;
  }

  function ashToggleButtonHTML(nodeId, enabled) {
    if (!nodeId) return "";
    const title = enabled
      ? "Пепел считается вместе с основным выходом: он едет тем же потоком и теми же лентами. Нажми, чтобы вернуть ему отдельную ленту"
      : "Пепел от сжигания топлива уезжает своей отдельной лентой. Нажми, чтобы считать его вместе с основным выходом (один общий поток)";
    return `<button type="button" class="ashToggleBtn${enabled ? " active" : ""}" data-node="${nodeId}" title="${title}">${
      enabled ? "Пепел: вместе с выходом ✓" : "Пепел: отдельно"
    }</button>`;
  }

  function toggleAshWithOutput(nodeId) {
    const treeNode = findTreeNodeById(state.cascade && state.cascade.root, nodeId);
    if (!treeNode) return;
    if (treeNode.ashWithOutput) delete treeNode.ashWithOutput;
    else treeNode.ashWithOutput = true;
    // Раскладка лент, а не производительность: пересчитывать цепочку не нужно.
    saveCurrentTabSnapshot();
    state.dirty = true;
    renderResults();
    renderInputResources();
  }

  // =========================================================================
  // МАНИПУЛЯТОРЫ И ПОГРУЗЧИКИ: загрузка и выгрузка заводов
  // =========================================================================
  //
  // Сколько манипуляторов нужно на один завод. Считается по потокам, которые физически
  // приходят и уходят, а не по предмету:
  //   * ВЫХОД — у завода один выходной инвентарь, манипулятор берёт из него любой предмет.
  //     На выгрузку нужен один поток: сумма твёрдых продуктов завода (с включённым «пепел
  //     вместе с выходом» — и пепла);
  //   * ВХОД — своя лента на группу ресурсов; пара по краям ленты едет одной лентой, и
  //     манипулятор берёт оба ресурса. Поэтому на каждую входную ленту свой манипулятор и
  //     свой поток (сумма ресурсов ленты), а выбор — на каждую ленту-группу;
  //   * ПЕПЕЛ — если он уезжает отдельной лентой, это отдельный поток со своим манипулятором;
  //   * ПОГРУЗЧИК — вместо манипулятора: тянет поток целиком со скоростью ленты. Если в
  //     дампе нет прототипов погрузчиков, список строится по предметам-погрузчикам и тиру
  //     ленты (скорость погрузчика равна скорости ленты его тира), в подсказке это помечено.
  //
  // Скорость и пачка берутся из раздела «Манипуляторы» (state.inserterSetup), дамп даёт
  // значения по умолчанию. Игра делает полный оборот за чётное число тиков (два
  // полуоборота), поэтому
  //   тиков = floor(1 / скорость_об_за_тик), при нечётном — на один меньше
  //   предметов/сек = (60 / тиков) × пачка
  // При пачке 1 это совпадает с таблицей вики (Inserter throughput): 0.013 → 0.79,
  // 0.02 → 1.2, 0.04 → 2.5, 0.06 → 3.75, 0.08 → 5, 0.1 → 6 предметов/сек. Базовые скорости
  // в наборе Bob's сдвинуты, поэтому по умолчанию берётся число из дампа.
  //
  // Единицы скорости. В прототипе — доля оборота за тик (rotation_speed), игра показывает
  // градусы в секунду: °/с = rotation_speed × 360 × 60 = rotation_speed × 21600
  // (ванильный inserter 0.014 → 302 °/с, burner-inserter 0.013 → 281 °/с, fast/bulk
  // 0.04 → 864 °/с). По умолчанию единица «°/сек», внутри всегда хранится об/тик.
  const DEGREES_PER_TURN = 360;
  const TICKS_PER_SECOND = 60;
  const DEG_PER_SEC_PER_TURN = DEGREES_PER_TURN * TICKS_PER_SECOND; // 21600

  function speedToTurns(value, unit) {
    const v = Number(value);
    if (!isFinite(v) || v <= 0) return null;
    if (unit === "deg") return v / DEG_PER_SEC_PER_TURN;
    if (unit === "sec") return 1 / (TICKS_PER_SECOND * v);
    return v;
  }

  function turnsToSpeed(turns, unit) {
    if (!(turns > 0)) return null;
    if (unit === "deg") return turns * DEG_PER_SEC_PER_TURN;
    if (unit === "sec") return 1 / (TICKS_PER_SECOND * turns);
    return turns;
  }

  /** Значение из раздела «Манипуляторы» для этого прототипа (или null = как в дампе). */
  function inserterSetupFor(name) {
    const s = (state.inserterSetup || {})[name];
    return s && typeof s === "object" ? s : null;
  }

  /** Пачка и скорость, которыми реально считается манипулятор: сначала раздел
   *  «Манипуляторы», потом дамп, потом встроенный минимум. */
  function inserterNumbers(e) {
    const setup = inserterSetupFor(e && e.name) || {};
    const dumpHand = inserterDumpHandSize(e);
    const dumpSpeed = typeof e.inserter_rotation_speed === "number" && e.inserter_rotation_speed > 0 ? e.inserter_rotation_speed : null;
    const hand = setup.hand > 0 ? Math.floor(setup.hand) : dumpHand;
    const speed = setup.speed > 0 ? setup.speed : dumpSpeed;
    return { hand, speed, dumpHand, dumpSpeed, handFromSetup: !!(setup.hand > 0), speedFromSetup: !!(setup.speed > 0) };
  }
  let inserterCache = null; // { dataset, setupKey, list }

  /** ПАЧКА по УМОЛЧАНИЮ (то, что даёт дамп): сколько предметов манипулятор берёт
   *  за один заход без ручных правок.
   *
   *    1 + врождённый бонус прототипа (stack_size_bonus) + бонус исследований.
   *
   *  Врождённый бонус лежит в прототипе (`inserter_stack_size_bonus` в дампе).
   *  Бонус исследований — в сохранении: у массовых манипуляторов это
   *  bulk_inserter_capacity_bonus, у остальных inserter_stack_size_bonus; экспортёр
   *  v4 приносит их как `inserter_bonus {stack, bulk}` и готовое `inserter_hand_size`.
   *  Если дамп старый, тут выйдет пачка 1 — и настоящее число вписывается в разделе
   *  «Манипуляторы» (он и есть источник правды, см. inserterNumbers). */
  function inserterDumpHandSize(e) {
    if (typeof e.inserter_hand_size === "number" && e.inserter_hand_size >= 1) return Math.floor(e.inserter_hand_size);
    const inherent =
      typeof e.stack_size_bonus === "number"
        ? e.stack_size_bonus
        : typeof e.inserter_stack_size_bonus === "number"
        ? e.inserter_stack_size_bonus
        : 0;
    // Прототип может запрещать бонус исследований (uses_inserter_stack_size_bonus).
    if (e.uses_stack_bonus_research === false) return 1 + Math.max(0, inherent);
    const bonus = datasetInserterBonus(state.dataset) || { stack: 0, bulk: 0 };
    const research = e.bulk ? bonus.bulk : bonus.stack;
    return 1 + Math.max(0, inherent) + Math.max(0, research);
  }

  /** Ключ кэшей: пачка, скорость и галочки приходят из раздела «Манипуляторы»,
   *  поэтому кэш обязан пересчитываться при любой правке там. */
  function inserterSetupKey() {
    const s = state.inserterSetup || {};
    const parts = Object.keys(s)
      .sort()
      .map((k) => {
        const v = s[k] || {};
        return `${k}:${v.hand || ""}/${v.speed || ""}${typeof v.use === "boolean" ? (v.use ? "/on" : "/off") : ""}`;
      });
    return parts.join("|") || "-";
  }

  /** Манипуляторы, которые РЕАЛЬНО можно предлагать: те, у кого стоит галочка
   *  «учитывать» и кто вообще что-то переносит. Снятая галочка убирает
   *  манипулятор и из авто-выбора, и из выпадающих списков — но в таблице
   *  раздела строка остаётся (см. buildInserterCatalogAll).
   *
   *  Весь ли список годится для ЧЕРТЕЖА — отдельный вопрос: на полном дампе чисел
   *  нет, и тогда манипуляторы в чертёж и сундук не уходят вовсе, даже если имя
   *  тут выбрано руками (см. inserterNumbersReliable). */
  function buildInserterCatalog() {
    const setupKey = inserterSetupKey();
    if (inserterCache && inserterCache.dataset === state.dataset && inserterCache.setupKey === setupKey) return inserterCache.list;
    const list = buildInserterCatalogAll()
      .filter((i) => !i.off && i.throughput > 0)
      .sort((a, b) => a.throughput - b.throughput || a.label.localeCompare(b.label));
    inserterCache = { dataset: state.dataset, list, setupKey };
    return list;
  }

  /** Все манипуляторы датасета с числами из раздела «Манипуляторы» (включая те,
   *  у которых нет скорости в дампе и те, у кого снята галочка). */
  function buildInserterCatalogAll() {
    return Object.values((state.dataset && state.dataset.entities) || {})
      .filter((e) => e && e.type === "inserter")
      .map((e) => {
        const nums = inserterNumbers(e);
        return {
          name: e.name,
          label: e.display_name || prettify(e.name),
          icon: e.icon_url || null,
          rotationSpeed: nums.speed,
          stackBonus: Math.max(0, nums.hand - 1),
          bulk: !!e.bulk,
          electric: e.energy_source_type === "electric",
          // Механический манипулятор этой сборки — «other»: он не ест ни
          // электричества, ни топлива, работает сам по себе. Такие подходят
          // везде, и в автоподборе они участвуют наравне с электрическими.
          powerless: !["electric", "burner", "fluid_fuel"].includes(e.energy_source_type),
          fuelFed: ["burner", "fluid_fuel"].includes(e.energy_source_type),
          hand: nums.hand,
          dumpHand: nums.dumpHand,
          dumpSpeed: nums.dumpSpeed,
          handFromSetup: nums.handFromSetup,
          speedFromSetup: nums.speedFromSetup,
          off: inserterIsOff(e.name),
          throughput: inserterThroughput(nums.speed, nums.hand - 1),
        };
      });
  }

  /** Скорость переноса: за полный оборот манипулятор делает один заход и несёт
   *  ПАЧКУ предметов, значит
   *    предметов/сек = (60 / тиков) × пачка.
   *  С пачкой 1 это знакомая таблица вики (0.02 → 1.2, 0.06 → 3.75), с пачкой 12
   *  скоростной массовый несёт 45/сек, как он и делает в игре. */
  function inserterThroughput(rotationSpeed, stackBonus) {
    if (!(rotationSpeed > 0)) return 0;
    let ticks = Math.floor(1 / rotationSpeed + 1e-9);
    if (ticks < 2) ticks = 2;
    if (ticks % 2 === 1) ticks -= 1; // полный оборот — всегда два полуоборота
    return (60 / ticks) * (1 + Math.max(0, stackBonus || 0));
  }

  let deviceCache = null; // { dataset, list } — манипуляторы + погрузчики

  /** Погрузчики. Сначала берутся прототипы из дампа (`loader-1x1`/`loader`): у них своя
   *  скорость, иконка и имя. Если их в дампе нет, список собирается по предметам-погрузчикам
   *  и тиру ленты: скорость погрузчика равна скорости ленты его тира (в loaders-modernized
   *  entity.speed = скорость подземной ленты того же тира), в подсказке указано, откуда
   *  число. */
  function buildLoaderCatalog() {
    const ents = Object.values((state.dataset && state.dataset.entities) || {});
    const real = ents
      .filter((e) => e && (e.type === "loader-1x1" || e.type === "loader") && e.belt_speed > 0)
      .map((e) => ({
        name: e.name,
        label: e.display_name || prettify(e.name),
        icon: e.icon_url || null,
        loader: true,
        off: inserterIsOff(e.name),
        throughput: e.belt_speed,
      }));
    if (real.length) {
      real.sort((a, b) => a.throughput - b.throughput || a.label.localeCompare(b.label));
      return real;
    }

    const belts = datasetBelts(state.dataset);
    if (!belts.length) return [];
    const beltByName = (n) => belts.find((b) => b.name === n) || null;
    const fastestBelt = belts[belts.length - 1];
    // Один тир — один погрузчик: «loader» и «mdrn-loader» это один и тот же тир,
    // две одинаковые строки в списке только путают (в этом наборе живые —
    // mdrn-*, они изучены, поэтому их и оставляем).
    const bySpeed = new Map();
    const items = Object.values((state.dataset && state.dataset.items) || {}).filter(
      (it) => it && typeof it.name === "string" && /(^|-)loader$/.test(it.name) && !/chute/.test(it.name)
    );
    for (const it of items) {
      const tier = it.name.replace(/^mdrn-/, "").replace(/-?loader$/, ""); // "" | fast | express | …
      const belt = tier === "" ? beltByName("transport-belt") : tier === "stack" ? fastestBelt : beltByName(`${tier}-transport-belt`);
      if (!belt || !(belt.belt_speed > 0)) continue; // такого тира в наборе нет — и погрузчика нет
      const speed = +belt.belt_speed.toFixed(2);
      const prev = bySpeed.get(speed);
      if (!prev || (/^mdrn-/.test(it.name) && !/^mdrn-/.test(prev.name))) {
        bySpeed.set(speed, {
          name: it.name,
          label: it.display_name || prettify(it.name),
          icon: it.icon_url || null,
          beltLabel: belt.display_name || prettify(belt.name),
        });
      }
    }
    return [...bySpeed.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([speed, v]) => ({
        name: v.name,
        label: v.label,
        icon: v.icon,
        loader: true,
        off: inserterIsOff(v.name),
        derived: true, // скорость взята по тиру ленты, а не из прототипа погрузчика
        beltLabel: v.beltLabel,
        throughput: speed,
      }));
  }

  /** Всё, что можно поставить в завод вместо манипулятора. */
  function buildDeviceCatalog() {
    const setupKey = inserterSetupKey();
    if (deviceCache && deviceCache.dataset === state.dataset && deviceCache.setupKey === setupKey) return deviceCache.list;
    const list = buildInserterCatalog().concat(buildLoaderCatalog().filter((l) => !l.off));
    deviceCache = { dataset: state.dataset, list, setupKey };
    return list;
  }

  /** Строки раздела «Манипуляторы»: все манипуляторы и все погрузчики, в том числе
   *  со снятой галочкой. */
  function buildDeviceCatalogAll() {
    const loaders = buildLoaderCatalog().map((l) => ({ ...l, hand: 0, rotationSpeed: 0, dumpHand: 0, dumpSpeed: 0 }));
    return buildInserterCatalogAll().concat(loaders);
  }

  function inserterByName(name) {
    return buildDeviceCatalog().find((i) => i.name === name) || null;
  }

  /** Постройка сама кладёт продукт на ленту — манипулятор на выход ей не нужен.
   *
   *  Так работают буры, Py-экстракторы (экстрактор грунта, бур земли,
   *  классификатор) и литейные аппараты: в их прототипе есть вектор выгрузки
   *  (vector_to_place_result), и продукт падает на тайл перед постройкой — то
   *  есть на ленту. Признак знает только файл геометрии, поэтому сервер отдаёт
   *  его вместе с датасетом (drops_to_belt). */
  function machineDropsToBelt(machineName) {
    const entities = state.dataset && state.dataset.entities;
    const rec = entities && machineName ? entities[machineName] : null;
    return !!(rec && rec.drops_to_belt);
  }

  /** Справляется ли самовыгрузка: завод с автовыгрузкой, которому за один проход получается столько, что это
   *  целая лента (выгрузка на завод не меньше скорости ленты: 15/с на жёлтой, 60 за 4 с — те же 15), сам на ленту
   *  не успевает. Тогда на тайле выгрузки стоит погрузчик, подходящий по скорости, и каждый завод выгружает
   *  на свою ленту. */
  function selfDumpNeedsLoader(n) {
    if (!n || !machineDropsToBelt(n.machineName)) return false;
    const machines = n.machines > 0 ? n.machines : 1;
    let rate = 0;
    for (const [k, v] of Object.entries(combinedOutputItems(n) || {})) {
      if (k.startsWith("item:") && v > 0) rate += v / machines;
    }
    const belt = (state.belt && state.belt.speed) || 15;
    return rate >= belt - 1e-9;
  }

  /** Самый медленный погрузчик, которого хватает на поток (иначе самый быстрый). */
  function defaultLoaderFor(rate) {
    const loaders = buildDeviceCatalog().filter((d) => d.loader).sort((a, b) => a.throughput - b.throughput);
    if (!loaders.length) return null;
    return loaders.find((d) => d.throughput + 1e-9 >= rate) || loaders[loaders.length - 1];
  }

  /** Потоки, которые физически приходят/уходят у ОДНОГО завода (см. шапку раздела).
   *  Каждый поток — это { id, keys, rates, rate }: лента (или выходной
   *  инвентарь), ресурсы на ней и их сумма на один завод. id группы не зависит
   *  от порядка ресурсов, чтобы выбранный манипулятор не терялся при пересчёте
   *  раскладки. */
  function stageInserterStreams(n, side, plan, root) {
    const machines = n && n.machines > 0 ? n.machines : 1;
    if (side === "ash") {
      const ash = stageAshInfoFor(n, root);
      if (!ash || ashWithOutputEnabled(n)) return [];
      const rate = ash.rate / machines;
      return rate > 0 ? [{ id: "ash", keys: [ash.key], rates: { [ash.key]: rate }, rate }] : [];
    }
    if (side === "in") {
      const solids = stageSolidInputs(n, root);
      const perMachine = {};
      for (const [k, v] of Object.entries(solids)) if (v > 0) perMachine[k] = v / machines;
      if (!Object.keys(perMachine).length) return [];
      const groups = [];
      if (plan && (plan.pairs.length || plan.soloKeys.length)) {
        // Раскладка подачи: пара по краям — это ОДНА лента (и один манипулятор),
        // одиночный ресурс — своя лента.
        for (const pair of plan.pairs) groups.push(pair.slice());
        for (const k of plan.soloKeys) groups.push([k]);
      } else {
        // Плана подачи нет (например, лента не выбрана) — считаем, что каждый
        // ресурс едет своей лентой.
        for (const k of Object.keys(perMachine)) groups.push([k]);
      }
      return groups
        .map((group) => {
          const keys = group.filter((k) => perMachine[k] > 0).sort();
          const rates = {};
          let rate = 0;
          for (const k of keys) {
            rates[k] = perMachine[k];
            rate += perMachine[k];
          }
          return { id: keys.join("|"), keys, rates, rate };
        })
        .filter((s) => s.keys.length && s.rate > 0);
    }
    // Выход: у завода ОДИН выходной инвентарь — манипулятор забирает из него всё,
    // поэтому это один поток, а не по потоку на каждый продукт.
    //
    // Исключение — постройки, которые кладут продукт на ленту САМИ (буры,
    // Py-экстракторы вроде экстрактора грунта, литейные аппараты): у них
    // манипулятора на выход нет вовсе, и советовать его нельзя. Признак едет
    // вместе с датасетом (drops_to_belt из файла геометрии).
    if (machineDropsToBelt(n && n.machineName) && !selfDumpNeedsLoader(n)) return [];
    const perMachine = Object.entries(combinedOutputItems(n) || {})
      .filter(([k, v]) => k.startsWith("item:") && v > 0)
      .map(([k, v]) => [k, v / machines]);
    if (!perMachine.length) return [];
    const rates = {};
    let rate = 0;
    for (const [k, v] of perMachine) {
      rates[k] = v;
      rate += v;
    }
    return [{ id: "out", keys: perMachine.map(([k]) => k), rates, rate }];
  }

  /** Ресурсы одной стороны НА ОДИН СТАНОК — плоским списком по ресурсам.
   *  Число манипуляторов по этому списку НЕ считается (манипулятор один на
   *  ленту-поток, см. stageInserterStreams) — список нужен для подписей. */
  function stageInserterItems(n, side, root) {
    const items = [];
    for (const stream of stageInserterStreams(n, side, null, root)) {
      for (const key of stream.keys) items.push({ key, rate: stream.rates[key] });
    }
    return { items, ash: side === "ash" && items.length > 0 };
  }

  function inserterCountForItem(rate, throughput) {
    if (!(throughput > 0) || !(rate > 0)) return 0;
    return Math.max(1, Math.ceil(rate / throughput - 1e-9));
  }

  function inserterCountFor(items, throughput) {
    return items.reduce((s, it) => s + inserterCountForItem(it.rate, throughput), 0);
  }

  /** Сколько устройств нужно на 1 завод для ПОТОКА (ленты или выхода).
   *  Один манипулятор обслуживает весь поток, поэтому считаем по сумме ресурсов
   *  потока, а не по каждому ресурсу: пара на одной ленте — это один манипулятор,
   *  а не два. */
  function streamInserterCount(stream, throughput) {
    if (!stream || !(throughput > 0) || !(stream.rate > 0)) return 0;
    return Math.max(1, Math.ceil(stream.rate / throughput - 1e-9));
  }

  /** Какой манипулятор подставить самому: самый медленный, которого ХВАТАЕТ
   *  одному на каждый ресурс (то есть «нужен 1 манипулятор»), а если такого
   *  нет — самый быстрый из имеющихся.
   *
   *  Кого рассматриваем:
   *    * электрические — всегда;
   *    * механические без питания вовсе (`powerless`, в этой сборке это
   *      «Механический манипулятор») — всегда: они работают сами по себе, и если
   *      скорости хватает, предлагаем именно их;
   *    * топливные (burner / паровые) — только когда сама постройка на топливе:
   *      там лента с топливом уже есть, а в электрической базе их не навязываем.
   */
  function defaultInserterFor(items, opts) {
    const all = buildInserterCatalog();
    if (!all.length) return null;
    const allowFuel = !!(opts && opts.allowFuel);
    const list = all.filter((i) => i.electric || i.powerless || (allowFuel && i.fuelFed));
    const candidates = list.length ? list : all;
    const need = items.reduce((m, it) => Math.max(m, it.rate), 0);
    if (!(need > 0)) return candidates[0];
    const enough = candidates.filter((i) => i.throughput + 1e-9 >= need);
    return enough.length ? enough[0] : candidates[candidates.length - 1];
  }

  /** Постройка топится твёрдым/жидким топливом (значит механический уместен). */
  function machineRunsOnFuel(machineName) {
    const machine = (state.dataset && state.dataset.entities || {})[machineName];
    if (!machine) return false;
    return compatibleFuels(state.dataset, machine).length > 0;
  }

  /** Что человек выбрал руками для этого потока, если выбрал.
   *  Вход хранится ПО ГРУППАМ-ЛЕНТАМ (`inserterIn = { "item:coal|item:ore": "fast-inserter" }`),
   *  потому что у каждой ленты свой манипулятор. Строка в старом формате (один выбор
   *  на весь вход) тоже понимается — как выбор для всех лент. */
  function storedInserterName(node, side, groupId) {
    if (!node) return null;
    const field = side === "in" ? "inserterIn" : side === "ash" ? "inserterAsh" : "inserterOut";
    const stored = node[field];
    if (!stored) return null;
    if (typeof stored === "string") return stored; // старый формат: один выбор на всё
    return (groupId && stored[groupId]) || null;
  }

  /** stream — поток ({id, rate}) либо (для совместимости) массив {key, rate}. */
  function chosenInserter(nodeId, side, stream) {
    const node = findTreeNodeById(state.cascade && state.cascade.root, nodeId);
    const isStream = stream && !Array.isArray(stream);
    const stored = storedInserterName(node, side, isStream ? stream.id : null);
    const chosen = stored ? inserterByName(stored) : null;
    const rate = isStream ? stream.rate : (stream || []).reduce((s, it) => s + it.rate, 0);
    const allowFuel = !!(node && machineRunsOnFuel(node.machineName));
    if (!chosen && side === "out") {
      const result = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
      if (selfDumpNeedsLoader(result)) return defaultLoaderFor(rate) || defaultInserterFor([{ rate }], { allowFuel });
    }
    return chosen || defaultInserterFor([{ rate }], { allowFuel });
  }

  function pluralDevices(n, loader) {
    const word = loader ? ["погрузчик", "погрузчика", "погрузчиков"] : ["манипулятор", "манипулятора", "манипуляторов"];
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return word[0];
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return word[1];
    return word[2];
  }

  function pluralInserters(n) {
    return pluralDevices(n, false);
  }

  /** Сколько нужно ИМЕННО ЭТИМ устройством — прямо в строке списка, чтобы не
   *  прокликивать варианты в поисках того, где хватит одного. «1 шт» подсвечено
   *  зелёным, больше — красным. */
  function inserterOptionCountHTML(need) {
    if (!(need > 0)) return "";
    return `<span class="inserterOptionCount ${need === 1 ? "one" : "many"}" title="Сколько таких нужно на 1 завод">${need} шт</span>`;
  }

  /** «пачка N» — сколько предметов устройство берёт за один заход. Пачка больше
   *  единицы меняет скорость переноса (предметов/сек = обороты × пачка), поэтому
   *  её видно и в списке, и в выбранном, и в подписи строки. */
  function inserterHandChipHTML(d) {
    if (!d || d.loader || !(d.hand > 1)) return "";
    return `<span class="inserterOptionHand" title="Пачка: ${d.hand} предметов за один заход (1 + бонус исследований). Скорость = обороты × пачка">пачка ${d.hand}</span>`;
  }

  /** Строка раскрытого списка: ИКОНКА + имя + пачка + скорость + сколько нужно. */
  function deviceOptionHTML(nodeId, side, stream, d, active) {
    const need = streamInserterCount(stream, d.throughput);
    const marks = [];
    if (d.hand > 1) marks.push(`пачка ${d.hand}`);
    if (!d.loader && !d.electric) marks.push("топливный");
    if (d.derived) marks.push(`скорость по тиру ленты «${d.beltLabel}»`);
    const title = `${d.label} — ${d.throughput.toFixed(2)} предметов/сек${marks.length ? ` (${marks.join(", ")})` : ""} · на 1 завод: ${need} шт`;
    return `<button type="button" class="inserterOption${active ? " active" : ""}${need === 1 ? " enough" : ""}" data-node="${nodeId}" data-side="${side}" data-group="${
      stream.id
    }" data-inserter="${d.name}" title="${title}">${iconImg(d.icon, 20)}<span class="inserterOptionName">${
      d.label
    }</span>${inserterHandChipHTML(d)}<span class="inserterOptionSpeed">${d.throughput.toFixed(2)}/сек</span>${inserterOptionCountHTML(
      need
    )}</button>`;
  }

  /** Одна строка = ОДИН поток (лента на входе / выход завода / пепел): выпадающий
   *  список устройств и число на 1 завод. */
  function inserterRowHTML(nodeId, side, stream, note) {
    const devices = buildDeviceCatalog();
    if (!devices.length) return "";
    const node = findTreeNodeById(state.cascade && state.cascade.root, nodeId);
    const chosen = chosenInserter(nodeId, side, stream);
    if (!chosen) return "";
    const stored = storedInserterName(node, side, stream.id);
    const count = streamInserterCount(stream, chosen.throughput);
    // Топливным постройкам механический манипулятор подходит, и он дешевле —
    // поэтому и в подсказке «что поставить» он участвует.
    const result = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
    const auto = side === "out" && selfDumpNeedsLoader(result)
      ? defaultLoaderFor(stream.rate)
      : defaultInserterFor([{ rate: stream.rate }], { allowFuel: machineRunsOnFuel(node && node.machineName) });
    const inserters = devices.filter((d) => !d.loader);
    const loaders = devices.filter((d) => d.loader);
    const names = stream.keys.map((k) => keyDisplayName(state.dataset, k));
    const label =
      side === "in"
        ? `Манипуляторы на вход (лента: ${names.join(" + ")})`
        : side === "ash"
        ? "Манипулятор на пепел"
        : "Манипуляторы на выход";
    const autoNeed = auto ? streamInserterCount(stream, auto.throughput) : 0;
    const autoOption = `<button type="button" class="inserterOption${stored ? "" : " active"}${
      autoNeed === 1 ? " enough" : ""
    }" data-node="${nodeId}" data-side="${side}" data-group="${
      stream.id
    }" data-inserter="__auto__" title="Самый медленный манипулятор, которого хватает на весь поток">${iconImg(
      auto && auto.icon,
      20
    )}<span class="inserterOptionName">Авто${auto ? ` — ${auto.label}` : ""}</span><span class="inserterOptionSpeed">${
      auto ? `${auto.throughput.toFixed(2)}/сек` : "по потоку"
    }</span>${inserterOptionCountHTML(autoNeed)}</button>`;
    const menu =
      `<div class="inserterMenu">` +
      `<div class="inserterMenuHint">Справа — сколько нужно на 1 завод; зелёным — хватит одного</div>` +
      `<div class="inserterMenuGroup">Авто</div>${autoOption}` +
      (inserters.length
        ? `<div class="inserterMenuGroup">Манипуляторы</div>${inserters
            .map((d) => deviceOptionHTML(nodeId, side, stream, d, stored === d.name))
            .join("")}`
        : "") +
      (loaders.length
        ? `<div class="inserterMenuGroup">Погрузчики</div>${loaders
            .map((d) => deviceOptionHTML(nodeId, side, stream, d, stored === d.name))
            .join("")}`
        : "") +
      `</div>`;
    const picker =
      `<div class="inserterPicker" data-node="${nodeId}" data-side="${side}" data-group="${stream.id}">` +
      `<button type="button" class="inserterPickBtn" title="Чем загружать/выгружать этот поток — нажми, чтобы выбрать">${iconImg(
        chosen.icon,
        20
      )}<span class="inserterPickLabel">${chosen.label}</span>${inserterHandChipHTML(
        chosen
      )}<span class="inserterPickSpeed">${chosen.throughput.toFixed(2)}/сек</span><span class="inserterCaret">▾</span></button>` +
      menu +
      `</div>`;
    const rateText =
      stream.keys.length > 1
        ? `${stream.keys.map((k) => `${keyDisplayName(state.dataset, k)} ${stream.rates[k].toFixed(2)}`).join(" + ")} = ${stream.rate.toFixed(
            2
          )}/сек`
        : `${names[0]} ${stream.rate.toFixed(2)}/сек`;
    // Пачку пишем и в подписи: видно, из чего вышла скорость (обороты × пачка).
    const handText = !chosen.loader && chosen.hand > 1 ? ` (пачка ${chosen.hand})` : "";
    const hint =
      side === "out" && stream.keys.length > 1
        ? `${chosen.label} несёт ${chosen.throughput.toFixed(2)}/сек${handText} — забирает ВЕСЬ выход завода: ${rateText}`
        : `${chosen.label} несёт ${chosen.throughput.toFixed(2)}/сек${handText} — на один завод ${rateText}`;
    const derivedNote = chosen.loader && chosen.derived ? ` <span class="hint">(скорость по тиру ленты «${chosen.beltLabel}»)</span>` : "";
    // Если манипуляторов нужно больше одного, полезно сразу знать, что погрузчик
    // потянет этот поток целиком: это и есть его смысл — «лента вместо рук».
    const loaderNote = (() => {
      if (count <= 1 || chosen.loader) return "";
      const one = loaders.find((d) => d.throughput + 1e-9 >= stream.rate);
      return one ? ` Погрузчиком хватит одного: ${one.label} · ${one.throughput.toFixed(2)}/сек.` : "";
    })();
    // У выхода подписи нет: скорость устройства видна на кнопке выбора. На входе подпись
    // остаётся — она объясняет, сколько манипулятор несёт на один завод.
    const hintHTML =
      side === "out"
        ? ""
        : `<span class="hint">${note ? `${note} ` : ""}${hint}${derivedNote}${loaderNote}</span>`;
    return `<div class="inserterRow">
        <span class="inserterLabel">${label}:</span>
        ${picker}
        <span class="inserterCount">${count} ${pluralDevices(count, !!chosen.loader)} на 1 завод</span>
        ${hintHTML}
      </div>`;
  }

  /** Открыть/закрыть раскрытый список у строки. Меню уже отрисовано (скрыто
   *  стилями), поэтому перерисовывать карточку не нужно — только класс. */
  function toggleInserterMenu(btn) {
    const picker = btn.closest(".inserterPicker");
    if (!picker) return;
    const wasOpen = picker.classList.contains("open");
    closeInserterMenus();
    // Класс ставим/снимаем у самой строки, а не полагаемся на выборку по документу:
    // так поведение одинаково и в браузере, и в тестовой заглушке DOM.
    if (wasOpen) picker.classList.remove("open");
    else picker.classList.add("open");
  }

  function closeInserterMenus() {
    document.querySelectorAll(".inserterPicker.open").forEach((p) => p.classList.remove("open"));
  }

  /** Строки манипуляторов: на входе их столько, сколько входных лент (потоков). */
  function inserterPickerHTML(nodeId, side, streams, note) {
    if (!nodeId || !streams || !streams.length) return "";
    if (!buildDeviceCatalog().length) return "";
    const rows = streams.map((s) => inserterRowHTML(nodeId, side, s, note)).filter(Boolean);
    if (!rows.length) return "";
    const html = rows.join("");
    if (side !== "in" || streams.length < 2) return html;
    // Несколько входных лент — итог по заводу: по одному устройству на каждую ленту.
    let total = 0;
    for (const s of streams) {
      const dev = chosenInserter(nodeId, side, s);
      if (dev) total += streamInserterCount(s, dev.throughput);
    }
    return `${html}<div class="inserterRow inserterRowTotal"><span class="hint">Итого на 1 завод: <b>${total}</b> — по потоку на каждую входную ленту.</span></div>`;
  }

  /** name = "__auto__" возвращает автоматический выбор (или убирает выбор для
   *  конкретной группы-ленты на входе). */
  function setStageInserter(nodeId, side, name, groupId) {
    const node = findTreeNodeById(state.cascade && state.cascade.root, nodeId);
    if (!node) return;
    const auto = !name || name === "__auto__";
    if (!auto && !inserterByName(name)) return;
    const field = side === "in" ? "inserterIn" : side === "ash" ? "inserterAsh" : "inserterOut";
    if (side === "in" && groupId) {
      const stored = node[field] && typeof node[field] === "object" ? { ...node[field] } : {};
      if (auto) delete stored[groupId];
      else stored[groupId] = name;
      if (Object.keys(stored).length) node[field] = stored;
      else delete node[field];
    } else if (auto) {
      delete node[field];
    } else {
      node[field] = name;
    }
    saveCurrentTabSnapshot();
    state.dirty = true;
    renderResults();
  }

  // Строка одного ресурса внутри общего выхода: какую долю общей ленты он занимает (не
  // полоса, а часть смешанного потока). Кнопки «Полная лента» у продукта нет: она во входе
  // («Полная лента этого ресурса»). Весь выход этапа укладывается в одну ленту кнопкой
  // «весь выход».
  function combinedOutputPartHTML(part, plan, nodeId, ashKey) {
    const icon = iconImg(keyIconUrl(state.dataset, part.key), 16);
    const name = keyDisplayName(state.dataset, part.key);
    const isAsh = ashKey && part.key === ashKey;
    const scope =
      plan.blocks <= 1
        ? `<span class="hint">(${isAsh ? "пепел от топлива, " : ""}${part.streamPct.toFixed(0)}% потока)</span>`
        : `<span class="hint">(${isAsh ? "пепел от топлива, " : ""}${part.streamPct.toFixed(0)}% потока, в блоке из ${plan.machinesPerBelt} ${pluralMachines(plan.machinesPerBelt)})</span>`;
    return `<li>${icon}<b>${name}</b>${isAsh ? ` <span class="hint">(побочка от сжигания топлива)</span>` : ""}: ${part.rate.toFixed(
      2
    )}/сек → занимает ${beltFillBarHTML(part.beltPct)} ленты ${scope}</li>`;
  }

  function fullBeltOutputButtonHTML(nodeId, plan, withAsh) {
    if (!nodeId || !plan || combinedOutputIsFullBelt(plan)) return "";
    const tail = withAsh
      ? "вместе с пеплом от сжигания топлива (пепел входит в тот же поток)"
      : "без пепла от сгорания — он уезжает своей лентой";
    return `<button type="button" class="fullBeltMultiBtn" data-node="${nodeId}" title="Пересчитать всю цепочку так, чтобы весь твёрдый выход этапа (все ресурсы вместе, ${tail}) заполнял ровно одну полную ленту — по стороне, с округлением вниз до целого числа заводов">Полная лента (весь выход)</button>`;
  }

  // «Приоритет — вход»: что и сколько уезжает с КАЖДОЙ кормящей группы и сколько
  // выходных лент нужно этапу при такой нарезке. Считается ровно тем же
  // правилом, что и обычный выход (computeCombinedOutputPlan), только на группу
  // вместо всего этапа — поэтому цифры не спорят с блоком «Выход».
  function renderOutputPriorityBoxHTML(n, prio) {
    if (prio !== "in") return "";
    const plan = computeFeedPlan(n);
    if (!plan) return "";
    const beltSpeed = state.belt.speed;
    const solids = Object.entries(n.products || {}).filter(([k, v]) => k.startsWith("item:") && v > 0);
    const totalRate = solids.reduce((s, [, v]) => s + v, 0);
    if (!(totalRate > 0)) {
      return `<div class="beltGroupNote alt">Приоритет — вход: выход считается по группам подачи. Твёрдых продуктов нет — всё уходит по трубе, выходных лент не нужно.</div>`;
    }
    const totalPhysical = plan.groupSizes.reduce((s, v) => s + v, 0);
    let totalBelts = 0;
    const rows = plan.groupSizes.map((m, i) => {
      const share = totalPhysical > 0 ? m / totalPhysical : 0;
      const flow = totalRate * share;
      // Считаем ПО ПОТОКУ: лента несёт beltSpeed/сек, значит группа с потоком F
      // занимает ceil(F / beltSpeed) лент. Раскладка «сколько заводов влезает на
      // одну ленту по сторонам» — это блок «Выход» ниже, там своё число.
      const belts = Math.max(1, Math.ceil(flow / beltSpeed - 1e-9));
      totalBelts += belts;
      const lastRate = flow - (belts - 1) * beltSpeed;
      const fill = Math.max(0, Math.min(100, (lastRate * 100) / beltSpeed));
      return `Группа ${i + 1} — <b>${m}</b> ${pluralMachines(m)}: поток <b>${flow.toFixed(2)}/сек</b> → <b>${belts} ${pluralBelts(
        belts
      )}</b>${fill < 99.5 ? ` <span class="hint">(последняя на ${fill.toFixed(0)}%)</span>` : ""}`;
    });
    // Второе чтение того же выхода: если весь этап ссыпать в один поток, лент
    // нужно меньше (машины разных групп могут выгружаться на общую ленту). Оба
    // числа полезны, поэтому говорим оба и объясняем разницу.
    const stageBelts = Math.max(1, Math.ceil(totalRate / beltSpeed - 1e-9));
    const stageNote =
      stageBelts < totalBelts
        ? ` Если сваливать весь выход этапа в общий поток — хватит <b>${stageBelts} ${pluralBelts(stageBelts)}</b>.`
        : "";
    return `<div class="beltGroupNote alt">Приоритет — вход: выход считается по группам подачи (лента несёт ${beltSpeed.toFixed(
      2
    )}/сек).<br/>${rows.join(
      "<br/>"
    )}<br/>На выход по группам: <b>${totalBelts} ${pluralBelts(totalBelts)}</b>${plan.numGroups > 1 ? ` — по ленте на группу` : ""}.${stageNote} Раскладка по целым заводам (сколько их влезает на одну ленту по сторонам) — в блоке «Выход» ниже, там своё число.</div>`;
  }

  // Раздел выхода этапа. Несколько ресурсов — группа на одной общей ленте, она рисуется в
  // рамке; один ресурс — обычная строка без рамки.
  // ---------- Блюпринт блока ----------
  //
  // Блок собирается по данным этапа (завод, рецепт, модули, число заводов) и выбору ленты,
  // манипуляторов и столба. Трубы сервер ставит только к портам, смотрящим наружу блока и в
  // коридор (см. block_pipes); остальные тайлы под газ и жидкость резервируются.
  function blueprintOptionsHTML(list, selected) {
    return list
      .map(
        (e) =>
          `<option value="${e.name}" data-icon="${e.icon_url || e.icon || ""}" ${e.name === selected ? "selected" : ""}>${e.display_name || prettify(e.name)}</option>`
      )
      .join("");
  }

  function blueprintEntities(type) {
    const ents = Object.values((state.dataset && state.dataset.entities) || {});
    return ents
      .filter((e) => e && e.type === type && e.name)
      .sort((a, b) => (a.display_name || a.name).localeCompare(b.display_name || b.name));
  }

  function blueprintPoleList() {
    // сначала те столбы, которых обычно хватает
    const order = ["bob-medium-electric-pole-2", "medium-electric-pole", "big-electric-pole", "substation"];
    return blueprintEntities("electric-pole").sort((a, b) => {
      const ia = order.indexOf(a.name);
      const ib = order.indexOf(b.name);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }

  function blueprintDefaultBeltName() {
    const belts = datasetBelts(state.dataset);
    if (!belts.length) return null;
    const speed = state.belt && state.belt.speed;
    const match = belts.find((b) => Math.abs((b.belt_speed || 0) - speed) < 1e-9);
    return (match || belts[belts.length - 1]).name;
  }

  /** Модули этапа в вид «имя -> количество» (в цепочке они списком). */
  function blueprintModulesFor(nodeId) {
    const treeNode = findTreeNodeById(state.cascade && state.cascade.root, nodeId);
    const out = {};
    const raw = (treeNode && treeNode.modules) || [];
    if (Array.isArray(raw)) {
      for (const m of raw) {
        if (m && m.name) out[m.name] = (out[m.name] || 0) + (m.count || 1);
      }
    } else if (raw && typeof raw === "object") {
      Object.assign(out, raw);
    }
    return out;
  }

  /** Чертёж ВСЕЙ цепочки на сундуках запроса. */
  function chainBlueprintStages() {
    const result = state.lastResult;
    if (!result || !result.nodes || !state.datasetId) return null;
    const stages = [];
    for (const node of Object.values(result.nodes)) {
      if (!node.machineName || !node.recipeName) continue;
      if (!(node.machinesCeil > 0)) continue;
      const groups = blueprintGroupsForStage(node.id);
      const pole = blueprintPoleList()[0];
      const inserterCounts = stageInserterCounts(node.id);
      // Манипуляторы — из раздела «Манипуляторы»; если чисел нет (полный дамп без
      // правок), отправляем null: сервер не ставит их и не заказывает в сундуке.
      const reliable = inserterNumbersReliable();
      const inserterIn = reliable ? blueprintInserterFromChain(node.id, "in") : null;
      const inserterOut = reliable ? blueprintInserterFromChain(node.id, "out") : null;
      stages.push({
        machine: node.machineName,
        recipe: node.recipeName,
        count: groups ? groups.total : node.machinesCeil,
        groups: groups && groups.groups.length > 1 ? groups.groups : null,
        inputBelts: groups && groups.belts ? groups.belts : null,
        modules: blueprintModulesFor(node.id),
        belt: blueprintDefaultBeltName() || "transport-belt",
        fuel: blueprintFuelFor(node.id),
        inserterIn,
        inserterOut,
        // Вход по лентам: у каждой ленты свой манипулятор (см. blueprintInserterInRows).
        inserterInRows: inserterIn ? blueprintInserterInRows(node.id) : null,
        inserterInCount: inserterIn ? inserterCounts.inCount : 0,
        inserterOutCount: inserterOut ? inserterCounts.outCount : 0,
        pole: pole ? pole.name : null,
        beltSides: blueprintBeltSides(),
        // Маяки этапа уезжают в сундук запроса, а не в чертёж: в блоке маяков нет.
        beacons: beaconPayloadForNode(findTreeNodeById(state.cascade.root, node.id)),
      });
    }
    return stages.length ? stages : null;
  }

  /** Имя цепочки, которая сейчас посчитана: оно уезжает в название чертежа. */
  function chainBlueprintName() {
    const root = state.cascade && state.cascade.root;
    const key = root && root.primaryProduct;
    if (!key) return null;
    return keyDisplayName(state.dataset, key) || prettify(String(key).replace(/^item:/, ""));
  }

  /** Разметка сундука: по умолчанию свёрнута.
   *
   *  Раздел показывает название и число позиций, строка и список раскрываются нажатием.
   */
  function chainChestHTML(data, chainName) {
    const rows = (data.items || [])
      .map((it) => {
        // Иконка берётся из датасета по ключу предмета.
        const icon = iconImg(keyIconUrl(state.dataset, "item:" + it.name), 20);
        const label = keyDisplayName(state.dataset, "item:" + it.name) || prettify(it.name);
        return `<li>${icon} ${label} — <b>${it.count}</b></li>`;
      })
      .join("");
    const warnings = [].concat(data.notes || []);
    if (data.partial) {
      warnings.unshift("всю цепочку собрать не получилось — в сундуке только фабрики и манипуляторы тех этапов, где блок не встал");
    }
    // Сундук заказывает постройки по всему расчёту: если среди них есть завод,
    // который в игре не скрафтить, сказать об этом надо здесь, а не в игре.
    warnings.push(...machineCraftNotesForResult());
    return (
      `<details class="bpDetails chainChest" id="chainChestDetails">` +
        `<summary>Сундук запроса${chainName ? ` для «${chainName}»` : ""}` +
        ` — позиций: <b>${data.positions || 0}</b> (нажми, чтобы раскрыть)</summary>` +
        `<textarea class="bpString" id="chainChestString" readonly rows="3">${data.string}</textarea>` +
        `<div class="bpPanelRow"><button type="button" class="btn bpCopyBtn">Скопировать строку</button>` +
        `<span class="hint">Вставь сундук на пустое место — поверх старого игра запросы может не обновить.</span></div>` +
        (rows ? `<ul class="bpList">${rows}</ul>` : "") +
        `<div class="hint">название чертежа в игре: ${data.label || "—"}</div>` +
      `</details>` +
      warnings.map((n) => `<div class="bpWarn">${n}</div>`).join("")
    );
  }

  /** Строка сундука исчезает, когда цепочка сменилась: чужой сундук не показываем. */
  function clearChainChest() {
    const out = document.getElementById("chainBlueprintResult");
    if (out) out.innerHTML = "";
  }

  /** Заводы всего расчёта, которые в игре не скрафтить — текстом для замечаний.
   *
   *  Один и тот же завод в разных этапах пишем один раз: список из двадцати
   *  одинаковых строк читать невозможно.
   */
  function machineCraftNotesForResult() {
    const notes = [];
    const seen = new Set();
    for (const node of Object.values((state.lastResult && state.lastResult.nodes) || {})) {
      const warning = machineCraftWarning(node.recipeName, node.machineName);
      if (!warning || seen.has(warning.machine)) continue;
      seen.add(warning.machine);
      notes.push(
        `завод «${warning.label}» в игре не скрафтить (рецепт скрыт)` +
        (warning.better ? ` — вместо него строится «${machineDisplayName(warning.better)}»` : "")
      );
    }
    return notes;
  }

  /** Скопировать текст в буфер. Возвращает true, если получилось. */
  async function copyTextToClipboard(text) {
    if (!text) return false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        void err;   // браузер мог запретить — попробуем старым способом
      }
    }
    const area = document.getElementById("chainChestString");
    if (!area) return false;
    // Из свёрнутого раздела выделить строку нельзя — раскрываем его, чтобы
    // запасной способ (Ctrl+C) точно сработал.
    const details = document.getElementById("chainChestDetails");
    if (details && !details.open) details.open = true;
    try {
      area.focus();
      area.select();
      return !!(document.execCommand && document.execCommand("copy"));
    } catch (err) {
      return false;
    }
  }

  async function buildChainBlueprint() {
    const out = document.getElementById("chainBlueprintResult");
    const stages = chainBlueprintStages();
    if (!out) return;
    if (!stages) {
      out.innerHTML = `<div class="bpWarn">Сначала посчитай цепочку.</div>`;
      return;
    }
    const chainName = chainBlueprintName();
    out.innerHTML = `<div class="hint">Собираю чертёж из ${stages.length} этапов${
      chainName ? ` для цепочки «${chainName}»` : ""
    }…</div>`;
    try {
      const response = await apiFetch("/api/shopping_list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetId: state.datasetId, stages, label: chainName }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.error) {
        out.innerHTML = `<div class="bpWarn">Не получилось: ${
          (data && data.error) || `сервер ответил ${response.status}`
        }</div>`;
        return;
      }
      out.innerHTML = chainChestHTML(data, chainName);
      // Кнопка и генерирует, и копирует в буфер.
      const copied = await copyTextToClipboard(data.string);
      const note = document.createElement("div");
      note.className = copied ? "hint" : "bpWarn";
      note.textContent = copied
        ? `Строка сундука скопирована в буфер (позиций: ${data.positions}). Раскрой раздел, если нужно посмотреть строку или список.`
        : `Скопировать не удалось — раскрой раздел и нажми «Скопировать строку» или Ctrl+C (позиций: ${data.positions}).`;
      out.prepend(note);
    } catch (err) {
      out.innerHTML = `<div class="bpWarn">Ошибка запроса: ${err}</div>`;
    }
  }

  /** «Сборщики всего»: по автомату на каждый рецепт, который делает постройку.
   *
   *  На каждый рецепт: автомат, два сундука (запроса и снабжения), манипулятор на загрузку и
   *  на выгрузку; в запросе всё нужное ×4. Собирает сервер (у него дамп и геометрия), сайт
   *  просит и показывает результат.
   *
   *  Строка всего молла — около 120 КБ, окно импорта игры её не принимает. Сервер отдаёт
   *  целый чертёж (файлом, его можно перетащить в игру) и части по maxChars символов для
   *  вставки по одной. */
  function mallBlueprintHTML(data) {
    const chunks = data.chunks || [];
    const whole = data.whole || null;
    const machines = Object.entries(data.perMachine || {})
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) =>
        `<li>${iconImg(keyIconUrl(state.dataset, "item:" + name), 20)} ${
          keyDisplayName(state.dataset, "item:" + name) || prettify(name)} — <b>${count}</b></li>`)
      .join("");
    const chunkHead = (chunk) =>
      `<summary>${chunk.label} — автоматы <b>${chunk.first}–${chunk.last}</b>, ` +
      `построек <b>${chunk.entities}</b>` +
      (chunk.size ? `, поле ${chunk.size.width}×${chunk.size.height}` : "") +
      (chunk.chars ? `, строка ${Math.round(chunk.chars / 1024 * 10) / 10} КБ` : "") + `</summary>`;
    const copyRow = (chunk, hint) =>
      `<div class="bpPanelRow"><button type="button" class="btn bpCopyBtn">Скопировать строку</button>` +
      `<span class="hint">${hint}</span></div>`;
    // Показываем первые части списком, остальные лежат файлами: рисовать сотню
    // текстовых полей по 4 КБ — только тормозить страницу.
    const shown = chunks.slice(0, 10);
    return (
      (whole
        ? `<div class="bpWarn">Строку целиком (${Math.round((whole.chars || 0) / 1024)} КБ, ` +
          `построек ${whole.entities}) в окно импорта игра не принимает — но её файл ` +
          `<b>${whole.file || "в папке generated"}</b> можно <b>перетащить прямо в окно игры</b> ` +
          `(так проходит даже очень длинная строка).</div>` +
          `<details class="bpDetails" open><summary>Целый молл: автоматов <b>${data.recipes || 0}</b>, ` +
          `построек <b>${whole.entities}</b>, строка ${Math.round((whole.chars || 0) / 1024)} КБ</summary>` +
          copyRow(whole, `файл: <b>${whole.file || "—"}</b> — перетащи его в окно игры`) +
          `</details>`
        : "") +
      `<div class="hint">Или по частям: <b>${chunks.length}</b> частей, каждая не длиннее ` +
      `<b>${Math.round((data.maxChars || 0) / 1024 * 10) / 10} КБ</b> — их можно вставлять по одной. ` +
      `Части лежат файлами в папке <b>generated</b> (mall-sborshchiki-&lt;номер&gt;-${chunks.length}.txt).</div>` +
      shown.map((chunk) =>
        `<details class="bpDetails"${chunk.index === 1 ? " open" : ""}>` + chunkHead(chunk) +
        `<textarea class="bpString" id="mallChunkString${chunk.index}" readonly rows="3">${chunk.string || ""}</textarea>` +
        copyRow(chunk, chunk.file ? `файл: <b>${chunk.file}</b>` : "вставь строку в игру") +
        `<details class="bpDetails"><summary>Что в этой части</summary><ul class="bpList">` +
        String(chunk.summary || "").split("\n").filter((line) => line.trim())
          .map((line) => `<li>${line}</li>`).join("") + `</ul></details>` +
        (chunk.problems || []).map((problem) => `<div class="bpWarn">${problem}</div>`).join("") +
        `</details>`
      ).join("") +
      (chunks.length > shown.length
        ? `<div class="hint">Остальные ${chunks.length - shown.length} частей — файлами в папке ` +
          `<b>generated</b>: их тоже можно перетаскивать в окно игры.</div>`
        : "") +
      (machines
        ? `<details class="bpDetails"><summary>Заводы (${Object.keys(data.perMachine || {}).length} видов)</summary>` +
          `<ul class="bpList">${machines}</ul></details>`
        : "")
    );
  }

  async function buildMallBlueprint() {
    const out = document.getElementById("mallBlueprintResult");
    if (!out) return;
    // Длина части задаётся пользователем: предел окна импорта у разных версий разный.
    const sizeSelect = document.getElementById("mallChunkSize");
    const maxChars = sizeSelect ? Math.max(500, Number(sizeSelect.value) || 4000) : 4000;
    out.innerHTML = `<div class="hint">Собираю «сборщики всего»: автомат на каждый рецепт постройки, ` +
      `части до ${Math.round(maxChars / 1024 * 10) / 10} КБ…</div>`;
    try {
      const response = await apiFetch("/api/mall_blueprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetId: state.datasetId, maxChars }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.error) {
        out.innerHTML = `<div class="bpWarn">Не получилось: ${
          (data && data.error) || `сервер ответил ${response.status}`
        }</div>`;
        return;
      }
      out.innerHTML = mallBlueprintHTML(data);
      const chunks = data.chunks || [];
      const copied = chunks.length ? await copyTextToClipboard(chunks[0].string) : false;
      const note = document.createElement("div");
      note.className = copied ? "hint" : "bpWarn";
      note.textContent = copied
        ? `Строка первой части скопирована в буфер (частей: ${chunks.length}). Остальные — по кнопке «Скопировать строку» в каждой части.`
        : `Скопировать не удалось — раскрой часть и нажми «Скопировать строку» (частей: ${chunks.length}).`;
      out.prepend(note);
    } catch (err) {
      out.innerHTML = `<div class="bpWarn">Ошибка запроса: ${err}</div>`;
    }
  }

  /** Разметка ответа «сундук по блюпринту»: что нашли и что просим. */
  function bpChestHTML(data) {
    const items = (data.items || [])
      .map((it) => {
        const icon = iconImg(keyIconUrl(state.dataset, "item:" + it.name), 20);
        const label = keyDisplayName(state.dataset, "item:" + it.name) || prettify(it.name);
        return `<li>${icon} ${label} — <b>${it.count}</b></li>`;
      })
      .join("");
    const found = (data.entities || [])
      .map((e) => {
        const icon = iconImg(keyIconUrl(state.dataset, "item:" + e.name), 18);
        const label = keyDisplayName(state.dataset, "item:" + e.name) || prettify(e.name);
        return `<li>${icon} ${label} — <b>${e.count}</b></li>`;
      })
      .join("");
    const warnings = [].concat(data.notes || []);
    return (
      `<details class="bpDetails chainChest" id="bpChestDetails" open>` +
        `<summary>Сундук для этого блюпринта — позиций: <b>${data.positions || 0}</b>, ` +
        `построек в чертеже: <b>${data.totalEntities || 0}</b></summary>` +
        `<textarea class="bpString" id="bpChestString" readonly rows="3">${data.string}</textarea>` +
        `<div class="bpPanelRow"><button type="button" class="btn bpCopyBtn">Скопировать строку</button>` +
        `<span class="hint">Вставь сундук на пустое место и построй его — он сам запросит всё из логистики.</span></div>` +
        `<div class="hint">название чертежа в игре: ${data.label || "—"}</div>` +
      `</details>` +
      `<details class="bpDetails" open><summary>Что просит сундук (${(data.items || []).length})</summary>` +
        `<ul class="bpList">${items}</ul></details>` +
      `<details class="bpDetails"><summary>Что нашлось в блюпринте (${(data.entities || []).length} видов)</summary>` +
        `<ul class="bpList">${found}</ul></details>` +
      warnings.map((n) => `<div class="bpWarn">${n}</div>`).join("")
    );
  }

  /** Вставил блюпринт — получил сундук со всем нужным и строку в буфере. */
  async function buildChestFromBlueprint() {
    const input = document.getElementById("bpChestInput");
    const out = document.getElementById("bpChestResult");
    if (!input || !out) return;
    const text = (input.value || "").trim();
    if (!text) {
      out.innerHTML = `<div class="bpWarn">Вставь строку блюпринта — поле пустое.</div>`;
      return;
    }
    out.innerHTML = `<div class="hint">Разбираю блюпринт…</div>`;
    try {
      const response = await apiFetch("/api/chest_for_blueprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetId: state.datasetId, string: text }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.error) {
        out.innerHTML = `<div class="bpWarn">Не получилось: ${
          (data && data.error) || `сервер ответил ${response.status}`
        }</div>`;
        return;
      }
      out.innerHTML = bpChestHTML(data);
      // Кнопка и разбирает, и копирует в буфер.
      const copied = await copyTextToClipboard(data.string);
      const note = document.createElement("div");
      note.className = copied ? "hint" : "bpWarn";
      note.textContent = copied
        ? `Строка сундука скопирована в буфер: ${data.totalEntities} построек разобрано, `
          + `просим ${data.positions} позиций.`
        : `Скопировать не удалось — раскрой раздел и нажми «Скопировать строку» или Ctrl+C `
          + `(построек разобрано: ${data.totalEntities}).`;
      out.prepend(note);
    } catch (err) {
      out.innerHTML = `<div class="bpWarn">Ошибка запроса: ${err}</div>`;
    }
  }

  function openBlueprintPanel(nodeId) {
    const wrap = document.getElementById(`bpPanel-${nodeId}`);
    if (!wrap) return;
    if (wrap.dataset.open === "1") {
      wrap.innerHTML = "";
      wrap.dataset.open = "0";
      return;
    }
    wrap.dataset.open = "1";
    wrap.innerHTML = blueprintPanelHTML(nodeId);
    updateBpRowsUI(nodeId);
  }

  /** Группы заводов, как их посчитал калькулятор (например 17+17+16+16).
   *
   *  Числа берутся из того же плана подачи, что рисует «Вход (что подвозить)»:
   *  это раскладка этапа по лентам, а не выдумка генератора. Если план говорит,
   *  что весь этап кормит одна лента — группа одна.
   */
  function blueprintGroupsForStage(nodeId) {
    const n = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
    if (!n) return null;
    const root = state.cascade && state.cascade.root;
    const treeNode = findTreeNodeById(root, nodeId);
    const source = treeNode ? { ...n, ...treeNode, id: nodeId, machines: n.machines } : n;
    let plan = null;
    try {
      plan = computeFeedPlan(source, root);
    } catch (e) {
      plan = null;
    }
    // Твёрдого на входе нет вовсе (рецепт «только жидкости», например битум):
    // лент подачи не нужно ни одной — всё приходит трубами. Генератор тогда не
    // ставит ни лент, ни манипуляторов. Про топку помнит сервер: твёрдое
    // топливо всё-таки возят лентой, поэтому число лент здесь не навязываем.
    const solids = Object.keys(stageSolidInputs(n, root) || {});
    const machinesCeil = Math.max(1, Math.ceil((n.machines || 1) - 1e-9));
    // Группы нулевого размера («1 + 4 × 0 заводов») в чертёж не идут: их нет, а число
    // рядов должно сходиться с числом настоящих групп.
    const sizes = plan && plan.groupSizes ? plan.groupSizes.filter((v) => v > 0) : null;
    if (!solids.length && (!sizes || !sizes.length)) {
      return { groups: [], total: machinesCeil, belts: 0,
               summary: "ленты подачи не нужны: у рецепта только жидкости" };
    }
    if (!sizes || !sizes.length) return null;
    const total = sizes.reduce((s, v) => s + v, 0);
    // Сколько лент подачи нужно ГРУППЕ — это тоже ответ калькулятора: он уже
    // разложил ресурсы по лентам (по два предмета на ленту по краям, тяжёлый —
    // на всю ленту). Больше трёх лент снаружи столбца не влезает.
    const belts = plan.beltsPerGroup || plan.totalBelts || null;
    const beltCount = !solids.length ? 0
      : (belts ? Math.max(1, Math.min(3, Math.round(belts))) : null);
    if (sizes.length <= 1) return { groups: sizes, total, belts: beltCount, summary: `одна группа: ${total}` };
    return { groups: sizes.slice(), total, belts: beltCount, summary: sizes.join(" + ") };
  }

  /** Манипулятор, выбранный в цепочке для самой нагруженной ленты этапа. */
  /** План подачи этапа — тот же, по которому карточка группирует потоки.
   *
   *  Без него `stageInserterStreams` считает поток на каждый ресурс, а не на ленту. Если два
   *  ресурса едут одной лентой (0.75/с и 1.25/с), карточка советует один манипулятор на
   *  2.00/с, а по ресурсам каждый «тянет» механический манипулятор (1.58/с), и в блок
   *  попадали бы два механических. */
  function stageFeedPlanFor(nodeId) {
    const n = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
    if (!n) return null;
    const root = state.cascade && state.cascade.root;
    const treeNode = findTreeNodeById(root, nodeId);
    const source = treeNode ? { ...n, ...treeNode, id: nodeId, machines: n.machines } : n;
    try {
      return computeFeedPlan(source, root) || null;
    } catch (e) {
      return null;
    }
  }

  /** Сторона выхода для чертежа: у рецепта с одними жидкостями выгрузка — только пепел от топлива. */
  function blueprintOutSide(nodeId, side) {
    if (side !== "out" || inserterStreamsSafe(nodeId, "out").length) return side;
    return inserterStreamsSafe(nodeId, "ash").length ? "ash" : side;
  }

  function blueprintInserterFromChain(nodeId, side) {
    const n = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
    if (!n) return null;
    side = blueprintOutSide(nodeId, side);
    const streams = inserterStreamsSafe(nodeId, side);
    if (!streams.length) return null;
    const busiest = streams.slice().sort((a, b) => (b.rate || 0) - (a.rate || 0))[0];
    const chosen = chosenInserter(nodeId, side, busiest);
    return chosen && chosen.name ? chosen.name : null;
  }

  /** Потоки стороны этапа — без падений: раскладка бывает неполной. */
  function inserterStreamsSafe(nodeId, side) {
    const n = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
    if (!n) return [];
    try {
      return stageInserterStreams(n, side, stageFeedPlanFor(nodeId), state.cascade && state.cascade.root) || [];
    } catch (e) {
      return [];
    }
  }

  /** Вход по лентам: у каждой ленты подачи свой манипулятор и своё число.
   *
   *  Карточка считает ленты отдельно, и на одной ленте может быть погрузчик, а на другой
   *  механический манипулятор; одним именем и числом на весь вход это не выразить.
   *  Порядок — от ближней ленты к дальней; какую считать дальней, решает генератор: на неё
   *  встаёт тот, кто до неё достаёт.
   */
  function blueprintInserterInRows(nodeId) {
    const rows = [];
    for (const stream of inserterStreamsSafe(nodeId, "in")) {
      const device = chosenInserter(nodeId, "in", stream);
      if (!device || !device.name) continue;
      const count = Math.max(1, streamInserterCount(stream, device.throughput) || 1);
      rows.push({ name: device.name, count });
    }
    return rows.length ? rows.slice(0, 2) : null;
  }

  /** Разметка панели: ничего выбирать не надо — всё берётся из цепочки. */
  // ---- ряды групп в чертеже блока ------------------------------------------
  // Этап режется на группы по ёмкости ленты (у «Цинковой плиты» — 31 группа), и
  // одной длинной полосой это строить неудобно. Человек задаёт, сколько групп
  // ставить в каждом РЯДУ блока: [5, 5, 5] — три ряда по пять групп, отступ между
  // рядами в чертеже 10 клеток. Здесь хранится введённое, чтобы панель не теряла
  // числа при перерисовке карточки.
  const bpRowPlans = {}; // { nodeId: [сколько групп в ряду, ...] }

  function bpRowsFor(nodeId, totalGroups) {
    const stored = bpRowPlans[nodeId];
    if (Array.isArray(stored) && stored.length) return stored.slice();
    return totalGroups > 0 ? [totalGroups] : [];
  }

  /** Забыть введённые ряды — при смене цепочки.
   *
   *  Ряды помнятся по id узла, а id у разных цепочек совпадают (n1, n2, ...).
   *  Без сброса этап новой цепочки показал бы чужие числа, написал бы «сумма по
   *  рядам не совпадает» и выключил «Собрать блюпринт» — как будто человек сам
   *  что-то ввёл. */
  function clearBpRows() {
    for (const key of Object.keys(bpRowPlans)) delete bpRowPlans[key];
  }

  function setBpRows(nodeId, rows) {
    const clean = (rows || []).map((v) => (v === "" || v == null ? null : Math.max(0, Math.trunc(Number(v) || 0))));
    bpRowPlans[nodeId] = clean;
    return clean;
  }

  /** Проверка рядов: поля не пустые и сумма равна числу групп этапа.
   *  Возвращает {ok, sum, total, machines, message}. */
  function bpRowsCheck(rows, totalGroups) {
    const total = Math.max(0, totalGroups || 0);
    const list = rows || [];
    // Групп нет (у рецепта только жидкие входы, делить по лентам нечего): проверять нечего,
    // «Собрать блюпринт» не блокируется.
    if (!total) return { ok: true, sum: 0, total: 0, machines: [], message: "" };
    if (!list.length) return { ok: false, sum: 0, total, machines: [], message: "Добавь хотя бы один ряд." };
    const empty = list.some((v) => !(v >= 1));
    const sum = list.reduce((s, v) => s + (v >= 1 ? v : 0), 0);
    if (empty) {
      return { ok: false, sum, total, machines: [], message: "Заполни все ряды: в каждом ряду должно стоять число групп (не пусто и не ноль)." };
    }
    if (sum !== total) {
      return {
        ok: false,
        sum,
        total,
        machines: [],
        message: `В рядах ${sum} ${pluralGroups(sum)}, а у этапа ${total} — сумма по рядам должна совпадать с числом групп.`,
      };
    }
    return { ok: true, sum, total, machines: [], message: "" };
  }

  /** Сколько заводов попадёт в каждый ряд — по группам этапа, в том же порядке. */
  function bpRowMachineCounts(rows, groupSizes) {
    const out = [];
    let pos = 0;
    for (const n of rows || []) {
      const take = (groupSizes || []).slice(pos, pos + (n >= 1 ? n : 0));
      out.push(take.reduce((s, v) => s + v, 0));
      pos += n >= 1 ? n : 0;
    }
    return out;
  }

  function bpRowsHTML(nodeId, groups) {
    const groupSizes = (groups && groups.groups) || [];
    const total = groupSizes.length;
    const rows = bpRowsFor(nodeId, total);
    const perRow = bpRowMachineCounts(rows, groupSizes);
    const items = rows
      .map(
        (value, i) =>
          `<div class="bpRowLine"><span class="bpRowLabel">Ряд ${i + 1}</span>` +
          `<input type="number" min="1" step="1" class="input bpRowInput" data-node="${nodeId}" data-row="${i}" value="${
            value == null ? "" : value
          }" title="Сколько групп поставить в этом ряду" />` +
          `<span class="bpRowHint">${perRow[i] ? `заводов: ${perRow[i]}` : "заводов: —"}</span>` +
          (rows.length > 1
            ? `<button type="button" class="btn btn-ghost btn-small bpRowRemove" data-node="${nodeId}" data-row="${i}" title="Убрать этот ряд">✕</button>`
            : "") +
          `</div>`
      )
      .join("");
    return (
      `<div class="bpRows" data-node="${nodeId}">` +
      `<div class="bpRowsHead">Ряды групп в блоке <span class="hint">отступ между рядами — 10 клеток</span></div>` +
      `<div class="bpRowsList">${items}</div>` +
      `<div class="bpPanelRow"><button type="button" class="btn btn-ghost btn-small bpRowAdd" data-node="${nodeId}">+ ряд</button>` +
      `<span class="bpRowsStatus" data-node="${nodeId}"></span></div>` +
      `</div>`
    );
  }

  /** Панель рядов после правки: сумма, заводы по рядам, ошибка и блокировка кнопки. */
  function rerenderBpRows(nodeId) {
    const wrap = document.querySelector(`.bpRows[data-node="${nodeId}"]`);
    const groups = blueprintGroupsForStage(nodeId);
    if (wrap && groups && groups.groups && groups.groups.length) {
      wrap.outerHTML = bpRowsHTML(nodeId, groups);
    }
    updateBpRowsUI(nodeId);
  }

  function updateBpRowsUI(nodeId) {
    const wrap = document.querySelector(`.bpRows[data-node="${nodeId}"]`);
    const groups = blueprintGroupsForStage(nodeId);
    const groupSizes = (groups && groups.groups) || [];
    const total = groupSizes.length;
    const rows = bpRowsFor(nodeId, total);
    const check = bpRowsCheck(rows, total);
    const perRow = bpRowMachineCounts(rows, groupSizes);
    if (wrap) {
      wrap.querySelectorAll(".bpRowInput").forEach((input) => {
        if (document.activeElement !== input) {
          const value = rows[Number(input.dataset.row)];
          input.value = value == null ? "" : String(value);
        }
      });
      const hint = wrap.querySelectorAll(".bpRowHint");
      hint.forEach((el, i) => {
        el.textContent = perRow[i] ? `заводов: ${perRow[i]}` : "заводов: —";
      });
      const status = wrap.querySelector(".bpRowsStatus");
      if (status) {
        status.innerHTML = check.ok
          ? `<span class="bpRowsOk">все ${total} ${pluralGroups(total)} разложены</span>`
          : `<span class="bpRowsBad">${check.message}</span>`;
      }
      const removeButtons = wrap.querySelectorAll(".bpRowRemove");
      removeButtons.forEach((btn) => {
        btn.disabled = rows.length <= 1;
      });
    }
    const buildBtn = document.querySelector(`.bpBuildBtn[data-node="${nodeId}"]`);
    if (buildBtn) {
      buildBtn.disabled = !check.ok;
      buildBtn.title = check.ok ? "" : check.message;
    }
    return check;
  }

  /** Куда едет лента выгрузки — настройка в блоке «Блюпринт блока».
   *
   *  Одна на всю цепочку: чертежи этапов и сундук по цепочке собираются одним и
   *  тем же генератором, и раскладка в них должна быть одинаковой. Поэтому выбор
   *  стоит в блоке чертежа, а не рядом с сундуком, и повторяется во всех открытых
   *  панелях — чтобы не было двух разных значений на экране. */
  function beltSidesPickHTML(nodeId) {
    const value = blueprintBeltSides();
    return (
      `<div class="bpSidesPick" title="Куда едет лента выгрузки в чертеже. «В одну сторону с подачей» — вход и выход подключаются с одного конца блока; «в другую сторону» — подача едет на север, выгрузка на юг.">` +
      `<span class="bpSidesLabel">Лента выхода:</span>` +
      `<select class="select beltSidesSelect" data-node="${nodeId}">` +
      `<option value="same"${value === "same" ? " selected" : ""}>в одну сторону с подачей</option>` +
      `<option value="opposite"${value === "opposite" ? " selected" : ""}>в другую сторону</option>` +
      `</select>` +
      `<span class="hint">действует на все чертежи: и на этот блок, и на сундук по цепочке</span>` +
      `</div>`
    );
  }

  function blueprintPanelHTML(nodeId) {
    const belts = datasetBelts(state.dataset);
    const beltName = blueprintDefaultBeltName();
    const belt = belts.find((b) => b.name === beltName);
    const groups = blueprintGroupsForStage(nodeId);
    const insIn = blueprintInserterFromChain(nodeId, "in");
    const insOut = blueprintInserterFromChain(nodeId, "out");
    const pole = blueprintPoleList()[0];
    const name = (n) => {
      const el = blueprintEntities("inserter").find((e) => e.name === n);
      return el ? el.display_name || prettify(el.name) : n;
    };
    return (
      `<div class="bpPanel">` +
      `<div class="bpPanelHead"><b>Блюпринт блока</b><button type="button" class="btn btn-ghost bpCloseBtn" data-node="${nodeId}">✕</button></div>` +
      `<div class="hint">Берётся из цепочки: ${
        groups ? `${groups.total} заводов, группы ${groups.summary}` : "заводы"
      }${belt ? `, лента ${belt.display_name || prettify(belt.name)}` : ""}${
        insIn ? `, вход ${name(insIn)}` : ""
      }${insOut && insOut !== insIn ? `, выход ${name(insOut)}` : ""}${
        pole ? `, столбы ${pole.display_name || prettify(pole.name)} (только если кому-то нужно электричество)` : ""
      }. Тайлы под газ и жидкость остаются свободными${
        blueprintPipes() ? ", кроме внешних портов: к ним ставятся подземные трубы" : ", трубы не ставятся"
      }.</div>` +
      (groups && groups.groups && groups.groups.length
        ? bpRowsHTML(nodeId, groups)
        : `<div class="hint">Делить на группы нечего: лент подачи у этапа нет — блок собирается целиком, рядами его не режут. Кнопка ниже работает.</div>`) +
      beltSidesPickHTML(nodeId) +
      `<div class="bpPanelRow">${bpPipesPickHTML()}</div>` +
      `<div class="bpPanelRow"><button type="button" class="btn bpBuildBtn" data-node="${nodeId}">Собрать блюпринт</button></div>` +
      `<div class="bpResult"></div>` +
      `</div>`
    );
  }

  /** Тело запроса к /api/blueprint: всё из цепочки, выбирать руками нечего. */
  /** Задание этапа для генератора: число заводов, группы и — важно — сколько
   *  манипуляторов нужно ОДНОМУ заводу с каждой стороны.
   *
   *  Считает это сайт: у него есть потоки этапа и таблица «пачка и скорость».
   *  Медленный манипулятор (механический тянет ~2/с) один поток не вытягивает,
   *  и тогда в чертёж должны встать все нужные, а не один. */
  function stageInserterCounts(nodeId) {
    const n = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
    if (!n) return { inCount: 1, outCount: 1 };
    const root = state.cascade && state.cascade.root;
    // Потоки — по лентам (план подачи), ровно как в карточке этапа: иначе на
    // каждый ресурс своей ленты насчитался бы свой манипулятор. См. stageFeedPlanFor.
    const plan = stageFeedPlanFor(nodeId);
    const counts = {};
    for (const side of ["in", "out"]) {
      // Манипулятора нет вовсе (числа неизвестны — полный дамп без правок):
      // значит и в чертеже его не будет, и считать «сколько их нужно» нечего.
      if (!blueprintInserterFromChain(nodeId, side)) {
        counts[side] = 0;
        continue;
      }
      let total = 0;
      const streamSide = blueprintOutSide(nodeId, side);
      try {
        for (const stream of stageInserterStreams(n, streamSide, plan, root) || []) {
          const device = chosenInserter(nodeId, streamSide, stream);
          const throughput = device ? device.throughput : 0;
          total += streamInserterCount(stream, throughput) || 0;
        }
      } catch (e) {
        void e;
      }
      counts[side] = Math.max(1, total);
    }
    return { inCount: counts.in, outCount: counts.out };
  }

  /** Топливо этапа (от него остаётся пепел, и блоку нужна лента выгрузки). */
  function blueprintFuelFor(nodeId) {
    const treeNode = findTreeNodeById(state.cascade && state.cascade.root, nodeId);
    return (treeNode && treeNode.fuelItem) || null;
  }

  function blueprintPayloadForNode(nodeId) {
    const node = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
    if (!node || !state.datasetId) return null;
    const groups = blueprintGroupsForStage(nodeId);
    const count = groups ? groups.total : Math.max(1, Math.ceil(node.machines - 1e-9) || 1);
    const recipe = state.dataset.recipes && state.dataset.recipes[node.recipeName];
    const pole = blueprintPoleList()[0];
    const inserterCounts = stageInserterCounts(nodeId);
    // Числа неизвестны (полный дамп без правок) — манипуляторы в чертёж не идут
    // вовсе: лучше честный скелет блока, чем угаданные числа (см. inserterNumbersReliable).
    const reliable = inserterNumbersReliable();
    const inserterIn = reliable ? blueprintInserterFromChain(nodeId, "in") : null;
    const inserterOut = reliable ? blueprintInserterFromChain(nodeId, "out") : null;
    return {
      datasetId: state.datasetId,
      machine: node.machineName,
      recipe: node.recipeName,
      count,
      groups: groups && groups.groups.length > 1 ? groups.groups : null,
      inputBelts: groups && groups.belts ? groups.belts : null,
      modules: blueprintModulesFor(nodeId),
      belt: blueprintDefaultBeltName() || "transport-belt",
      fuel: blueprintFuelFor(nodeId),
      inserterIn,
      inserterOut,
      // Вход по лентам: у каждой ленты свой манипулятор (см. blueprintInserterInRows).
      inserterInRows: inserterIn ? blueprintInserterInRows(nodeId) : null,
      inserterInCount: inserterIn ? inserterCounts.inCount : 0,
      inserterOutCount: inserterOut ? inserterCounts.outCount : 0,
      pole: pole ? pole.name : null,
      // Куда едет лента выгрузки относительно подачи — выбор в блоке «Блюпринт блока».
      beltSides: blueprintBeltSides(),
      pipes: blueprintPipes(),
      pipe: (selectedPipe() || {}).name || null,
      // Сколько групп в каждом ряду блока (панель «Блюпринт блока»); сумму проверяют панель и сервер.
      rowGroups: bpRowsFor(nodeId, groups ? groups.groups.length : 0),
      label: `${recipe ? recipeDisplayName(recipe) : node.recipeName} × ${count}`,
      // Маяков в чертеже нет: они считаются в подсчёте заводов (эффект) и в сундуке запроса
      // (сколько купить).
    };
  }

  /** Подземные трубы от портов жидкости, смотрящих наружу блока (по умолчанию да). */
  function blueprintPipes() {
    if (state.bpPipes === undefined) {
      let stored = null;
      try {
        stored = localStorage.getItem("chaincalc_bp_pipes");
      } catch (e) {
        stored = null;
      }
      state.bpPipes = stored !== "0";
    }
    return !!state.bpPipes;
  }

  function setBlueprintPipes(flag) {
    state.bpPipes = !!flag;
    try {
      localStorage.setItem("chaincalc_bp_pipes", flag ? "1" : "0");
    } catch (e) {
      /* не запомнится между сессиями — не страшно */
    }
  }

  function bpPipesPickHTML() {
    return (
      `<label class="bpPipesPick" title="У порта жидкости, который смотрит наружу блока, ставится подземная труба, за лентами — вторая, а от неё ствол из труб вдоль края группы. Порты внутрь блока остаются свободными.">` +
      `<input type="checkbox" class="bpPipesBox"${blueprintPipes() ? " checked" : ""} /> подземные трубы от внешних портов жидкости</label>`
    );
  }

  /** Настройка «выход в ту же сторону, что подача» / «в другую сторону». */
  function blueprintBeltSides() {
    return state.beltSides === "opposite" ? "opposite" : "same";
  }

  function setBeltSides(value) {
    state.beltSides = value === "opposite" ? "opposite" : "same";
    state.dirty = true;
  }

  // ---- картинка раскладки ----------------------------------------------------
  // Сервер присылает `preview` (blueprint.preview_data): по записи на постройку
  // [вид, лево, верх, ширина, высота, куда, имя, рецепт]. Рисуем её SVG-ом в
  // координатах тайлов: масштаб меняется шириной картинки, а не перерисовкой.

  const PREVIEW_KIND_LABELS = {
    machine: "завод",
    belt: "лента",
    underground: "подземная лента",
    splitter: "разветвитель",
    loader: "погрузчик",
    inserter: "манипулятор",
    pipe: "труба",
    "pipe-ground": "подземная труба",
    rail: "рельсы",
    stop: "стоп",
    warehouse: "склад",
    pole: "столб",
    other: "прочее",
  };
  // порядок отрисовки: нижнее — первым, столбы поверх всего
  const PREVIEW_ORDER = ["rail", "machine", "warehouse", "other", "pipe", "pipe-ground", "belt", "underground", "splitter", "loader", "inserter", "stop", "pole"];

  function previewEscape(text) {
    return String(text == null ? "" : text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /** Стрелка вдоль потока в тайле (left, top): остриё вперёд, основание сзади. */
  function previewArrow(left, top, flow, cls, title) {
    const cx = left + 0.5;
    const cy = top + 0.5;
    const fx = flow[0];
    const fy = flow[1];
    const px = -fy;
    const py = fx;
    const pts = [
      [cx + fx * 0.42, cy + fy * 0.42],
      [cx - fx * 0.3 + px * 0.3, cy - fy * 0.3 + py * 0.3],
      [cx - fx * 0.3 - px * 0.3, cy - fy * 0.3 - py * 0.3],
    ];
    return `<polygon class="${cls}" points="${pts.map((p) => `${+p[0].toFixed(2)},${+p[1].toFixed(2)}`).join(" ")}"><title>${title}</title></polygon>`;
  }

  /** SVG раскладки: {svg, width, height} в тайлах, либо null, если рисовать нечего. */
  function blueprintPreviewSVG(preview, reservedTiles, portTiles) {
    if (!preview || !Array.isArray(preview.items) || !preview.items.length) return null;
    const reserved = (reservedTiles || []).filter((t) => Array.isArray(t) && t.length >= 2);
    const ports = (portTiles || []).filter((t) => Array.isArray(t) && t.length >= 2);
    let minX = preview.x0;
    let minY = preview.y0;
    let maxX = preview.x0 + preview.width;
    let maxY = preview.y0 + preview.height;
    for (const t of reserved.concat(ports)) {
      minX = Math.min(minX, t[0]);
      minY = Math.min(minY, t[1]);
      maxX = Math.max(maxX, t[0] + 1);
      maxY = Math.max(maxY, t[1] + 1);
    }
    const pad = 1;
    const x0 = minX - pad;
    const y0 = minY - pad;
    const width = maxX - minX + 2 * pad;
    const height = maxY - minY + 2 * pad;
    const out = [];
    for (const t of reserved) {
      out.push(`<rect class="pv-reserved" x="${t[0]}" y="${t[1]}" width="1" height="1"><title>${i18nText("тайл под газ/жидкость — свободен, трубу ведёт игрок")}</title></rect>`);
    }
    for (const t of ports) {
      out.push(`<rect class="pv-port" x="${t[0]}" y="${t[1]}" width="1" height="1"><title>${i18nText("порт жидкости")}</title></rect>`);
    }
    const kindsSeen = new Set();
    const sorted = preview.items
      .slice()
      .sort((a, b) => PREVIEW_ORDER.indexOf(a[0]) - PREVIEW_ORDER.indexOf(b[0]));
    for (const [kind, left, top, w, h, flow, name, recipe] of sorted) {
      kindsSeen.add(kind);
      const label = PREVIEW_KIND_LABELS[kind] || kind;
      const title = previewEscape(`${i18nText(label)}: ${name}${recipe ? ` · ${recipe}` : ""}`);
      const cls = `pv-${kind}`;
      if (kind === "belt" || kind === "inserter" || kind === "loader") {
        if (kind !== "belt") out.push(`<rect class="${cls}-bg" x="${left + 0.1}" y="${top + 0.1}" width="0.8" height="0.8" rx="0.15"><title>${title}</title></rect>`);
        else out.push(`<rect class="pv-belt-bg" x="${left}" y="${top}" width="1" height="1"><title>${title}</title></rect>`);
        if (flow) out.push(previewArrow(left, top, flow, `${cls}-arrow`, title));
        continue;
      }
      if (kind === "pole") {
        out.push(`<circle class="${cls}" cx="${left + w / 2}" cy="${top + h / 2}" r="0.38"><title>${title}</title></circle>`);
        continue;
      }
      out.push(`<rect class="${cls}" x="${left + 0.04}" y="${top + 0.04}" width="${w - 0.08}" height="${h - 0.08}" rx="0.12"><title>${title}</title></rect>`);
      if (flow && (kind === "underground" || kind === "splitter" || kind === "pipe-ground")) {
        out.push(previewArrow(left + (w - 1) / 2, top + (h - 1) / 2, flow, `${cls}-arrow`, title));
      }
    }
    const svg =
      `<svg class="bpPreviewSvg" xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${width} ${height}" ` +
      `data-w="${width}" data-h="${height}" role="img" aria-label="${i18nText("Схема раскладки")}">${out.join("")}</svg>`;
    return { svg, width, height, kinds: [...kindsSeen] };
  }

  /** Блок «Схема раскладки»: картинка с прокруткой, кнопками масштаба и легендой. */
  function blueprintPreviewHTML(data) {
    const picture = blueprintPreviewSVG(data && data.preview, data && data.reservedTiles, data && data.portTiles);
    if (!picture) return "";
    const cell = Math.max(6, Math.min(18, Math.floor(900 / picture.width)));
    const legend = PREVIEW_ORDER.filter((k) => picture.kinds.includes(k))
      .map((k) => `<span class="pvLegendItem"><i class="pvSwatch pv-${k}-sw"></i>${i18nText(PREVIEW_KIND_LABELS[k])}</span>`)
      .join("");
    const reservedLegend = (data.reservedTiles || []).length
      ? `<span class="pvLegendItem"><i class="pvSwatch pv-reserved-sw"></i>${i18nText("тайлы под трубы")}</span>`
      : "";
    return (
      `<details class="bpDetails bpPreview" open>` +
      `<summary>Схема раскладки <span class="hint">(${picture.width - 2} × ${picture.height - 2} тайлов)</span></summary>` +
      `<div class="bpPreviewTools"><button type="button" class="btn btn-ghost btn-small bpZoomBtn" data-dir="-1" title="Мельче">−</button>` +
      `<button type="button" class="btn btn-ghost btn-small bpZoomBtn" data-dir="1" title="Крупнее">+</button>` +
      `<span class="pvLegend">${legend}${reservedLegend}</span></div>` +
      `<div class="bpPreviewScroll" data-cell="${cell}">${picture.svg.replace(
        "<svg ",
        `<svg style="width:${picture.width * cell}px;height:${picture.height * cell}px" `
      )}</div>` +
      `</details>`
    );
  }

  /** Масштаб схемы: шаг ±25%, от 4 до 40 пикселей на тайл. */
  function zoomBlueprintPreview(button) {
    const scroll = button.closest(".bpPreview") && button.closest(".bpPreview").querySelector(".bpPreviewScroll");
    const svg = scroll && scroll.querySelector("svg");
    if (!svg) return;
    const dir = Number(button.dataset.dir) > 0 ? 1 : -1;
    const cell = Math.max(4, Math.min(40, (Number(scroll.dataset.cell) || 10) * (dir > 0 ? 1.25 : 0.8)));
    scroll.dataset.cell = String(cell);
    svg.style.width = `${+(Number(svg.dataset.w) * cell).toFixed(1)}px`;
    svg.style.height = `${+(Number(svg.dataset.h) * cell).toFixed(1)}px`;
  }

  /** Что показать после сборки: строка, кнопка копирования, замечания, разбор.
   *
   *  Про маяки здесь ничего нет намеренно: в чертёж они не входят (см.
   *  blueprintPayloadForNode), поэтому и отчитываться не о чем.
   */
  function blueprintResultHTML(data, payload) {
    const warnings = []
      .concat(data.problems || [])
      .concat(data.fluidProblems || [])
      .map((t) => `<div class="bpWarn">${t}</div>`)
      .join("");
    // Завод, который в игре не скрафтить, в строке чертежа заметен только тем, что
    // «Что именно построится» показывает его имя. Скажем об этом здесь — рядом с
    // кнопкой копирования, а не после постройки.
    const craftNote = payload
      ? machineCraftNoteHTML(null, payload.recipe, payload.machine)
      : "";
    return (
      `<textarea class="bpString" readonly rows="3">${data.string}</textarea>` +
      `<div class="bpPanelRow"><button type="button" class="btn bpCopyBtn">Скопировать строку</button>` +
      `<span class="hint">построек: ${data.entityCount} · заводов: ${payload.count}${
        payload.groups && payload.groups.length > 1 ? ` (${payload.groups.join(" + ")})` : ""
      } · столбов: ${data.poles} · потребителей: ${data.consumers}</span></div>` +
      craftNote +
      (warnings ? `<div class="bpWarns">${warnings}</div>` : "") +
      ((data.notes || []).length
        ? `<details class="bpDetails"><summary>Замечания генератора (${data.notes.length})</summary>${data.notes
            .map((t) => `<div class="hint">${previewEscape(t)}</div>`)
            .join("")}</details>`
        : "") +
      blueprintPreviewHTML(data)
    );
  }

  /** Запрос к серверу за блюпринтом: {ok, data} или {ok:false, message}. */
  async function requestBlueprint(payload) {
    try {
      const response = await apiFetch("/api/blueprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.error) {
        return { ok: false, message: (data && data.error) || `сервер ответил ${response.status}` };
      }
      return { ok: true, data };
    } catch (err) {
      return { ok: false, message: `ошибка запроса: ${err}` };
    }
  }

  async function buildBlueprintForStage(nodeId) {
    const wrap = document.getElementById(`bpPanel-${nodeId}`);
    if (!wrap) return;
    const result = wrap.querySelector(".bpResult");
    const payload = blueprintPayloadForNode(nodeId);
    if (!payload || !result) return;
    result.innerHTML = `<div class="hint">Собираю…</div>`;
    const answer = await requestBlueprint(payload);
    result.innerHTML = answer.ok
      ? blueprintResultHTML(answer.data, payload)
      : `<div class="bpWarn">Не получилось: ${answer.message}</div>`;
  }

  /** Где лежит строка чертежа для этой кнопки.
   *
   *  Панель сундука на всю цепочку лежит в обычном `.bpResult`, а не в `.bpPanel`, поэтому
   *  контейнеры перебираются по очереди, начиная с переданного обработчиком.
   */
  function pickBlueprintArea(candidates) {
    for (const el of candidates || []) {
      if (!el || typeof el.querySelector !== "function") continue;
      const area = el.querySelector(".bpString");
      if (area) return area;
    }
    return null;
  }

  function copyBlueprintString(btn, scope) {
    const area = pickBlueprintArea([
      scope,
      btn.closest && btn.closest(".bpPanel"),
      btn.closest && btn.closest(".bpResult"),
      btn.parentElement,
    ]);
    if (!area) {
      btn.textContent = "Не нашёл строку — выделите и скопируйте вручную";
      setTimeout(() => (btn.textContent = "Скопировать строку"), 3000);
      return;
    }
    try {
      area.focus();
      area.select();
    } catch (e) {
      void e;
    }
    let done = false;
    try {
      done = !!(document.execCommand && document.execCommand("copy"));
    } catch (e) {
      done = false;
    }
    if (!done && navigator.clipboard && navigator.clipboard.writeText) {
      // Копируем ровно то, что показано на экране.
      try {
        navigator.clipboard.writeText(area.value);
        done = true;
      } catch (e) {
        done = false;
      }
    }
    // «Скопировано» пишется только если копирование удалось: иначе в игру попадёт старый буфер.
    btn.textContent = done ? "Скопировано ✓" : "Не скопировалось — нажмите Ctrl+C";
    setTimeout(() => (btn.textContent = "Скопировать строку"), done ? 1500 : 4000);
  }

  function renderBeltCell(n) {
    const plan = computeCombinedOutputPlan(combinedOutputItems(n), n.machines);
    if (!plan) return "";
    const ash = stageAshInfoFor(n);
    const ashKey = ashWithOutputEnabled(n) && ash ? ash.key : null;
    // Постройка сама кладёт продукт на ленту (буры, Py-экстракторы, литейные
    // аппараты): манипулятора на выход нет вовсе, и в чертёж он не ставится.
    const needsLoader = selfDumpNeedsLoader(n);
    const selfDump = machineDropsToBelt(n && n.machineName) && !needsLoader;
    const selfDumpNote = needsLoader
      ? `<div class="beltGroupNote alt">Выгрузка завода — целая лента или больше: завод сам не успеет выложить всё на ` +
        `ленту. На тайле выгрузки стоит погрузчик, подходящий по скорости, и каждый завод выгружает на свою ленту ` +
        `(ленты тянешь сам).</div>`
      : selfDump
      ? `<div class="beltGroupNote alt">Постройка сама кладёт продукт на ленту — манипулятор ` +
        `на выход не нужен, в чертёж он не ставится.</div>`
      : "";
    // Манипуляторы на выход: ОДИН поток — из выходного инвентаря завода
    // манипулятор забирает всё, что там лежит (см. шапку раздела). Пояснять это
    // в карточке не нужно: строка «один манипулятор забирает весь выход» внизу
    // этапа только повторяла одно и то же дважды, поэтому её убрали совсем.
    const outStreams = stageInserterStreams(n, "out");
    const inserterRow = selfDump ? "" : inserterPickerHTML(n.id, "out", outStreams, "");
    const withInserter = (html) => `${html}<div class="inserterRowWrap">${inserterRow}</div>`;
    // С кнопкой «весь выход»: у продукта своей кнопки больше нет (она переехала
    // во вход), поэтому «весь выход» показываем и когда продукт один — там это
    // ровно то же самое.
    const btn = fullBeltOutputButtonHTML(n.id, plan, !!ashKey);
    const note =
      selfDumpNote +
      combinedOutputNoteHTML(plan, n.id) +
      (ashKey
        ? `<div class="beltGroupNote alt">Пепел от сжигания топлива считается вместе с выходом: он входит в этот поток и в эти ленты. Нажми «Пепел: вместе с выходом ✓» у заголовка, чтобы вернуть ему отдельную ленту.</div>`
        : "");
    const rows = plan.parts.map((p) => combinedOutputPartHTML(p, plan, n.id, ashKey)).join("");
    if (plan.parts.length < 2) {
      return withInserter(`${note}<ul class="beltList">${rows}</ul>${btn ? `<div class="beltBtnRow">${btn}</div>` : ""}`);
    }
    return withInserter(
      `<div class="beltGroupBox">` +
        `<div class="beltGroupBoxHead"><span class="beltGroupBoxLabel">Общая лента · ${plan.parts.length} ${pluralResources(
          plan.parts.length
        )} (суммарный поток)</span>${btn}</div>` +
        `${note}<ul class="beltList">${rows}</ul>` +
        `</div>`
    );
  }

  function renderIngredientBeltCell(n) {
    return renderItemsBeltCell(n.ingredients, n.machines, "in", n.id);
  }

  function feedResourceLabel(key, plan) {
    const icon = iconImg(keyIconUrl(state.dataset, key), 16);
    const name = keyDisplayName(state.dataset, key);
    const split = plan.inputSplit && plan.inputSplit[key];
    const fuel = key === plan.fuelKey ? ` <span class="hint">(топливо${split && split.recipe > 0 ? " + в рецепте" : ""})</span>` : "";
    return `${icon}<b>${name}</b>${fuel}`;
  }

  /** «нужно 79.17/сек (в рецепт 66.67 + в топку 12.50)» — чтобы было видно, что
   *  уголь посчитан и как ресурс рецепта, и как топливо печи. Числа — на ту же
   *  группу, что и «на группу» в строке. */
  function feedRecipeFuelSplitHTML(key, plan) {
    const split = plan.info && plan.info[key] && plan.info[key].splitPerGroup;
    if (!split || !(split.fuel > 0.005) || !(split.recipe > 0.005)) return "";
    return ` <span class="hint">(в рецепт ${split.recipe.toFixed(2)} + в топку печей ${split.fuel.toFixed(2)})</span>`;
  }

  // Is this fed line already exactly one belt (or one side of a shared belt)?
  // Then the «Полная лента» button would change nothing and is hidden.
  function feedLineAlreadyFull(key, plan) {
    const i = plan.info[key];
    if (!i) return false;
    return i.shared ? i.lanePct >= 99.5 : i.beltPct >= 99.5;
  }

  // «21.00/сек на группу» при двух группах — это половина потребности; рядом пишем и общую сумму по этапу.
  function feedTotalHintHTML(i, plan) {
    if (!plan || !(plan.numGroups > 1) || !(i.rate > 0)) return "";
    return ` <span class="hint">(всего ${i.rate.toFixed(2)}/сек)</span>`;
  }

  // A resource that gets a belt to itself.
  function feedSoloLineHTML(key, plan, nodeId) {
    const i = plan.info[key];
    const btn = feedLineAlreadyFull(key, plan) ? "" : ` ${fullBeltResourceLineButtonHTML(nodeId, key, false)}`;
    if (i.impossible) {
      return `<li>${feedResourceLabel(key, plan)}: ⚠ одному заводу нужно <b>${i.beltsPerMachine} ${pluralBelts(
        i.beltsPerMachine
      )}</b> — он потребляет больше, чем несёт целая лента (${plan.beltSpeed.toFixed(2)}/сек)${btn}</li>`;
    }
    return `<li>${feedResourceLabel(key, plan)}: <b>${i.perGroup.toFixed(2)}/сек</b> на группу${feedTotalHintHTML(i, plan)} → <b>1 лента</b> целиком ${beltFillBarHTML(
      i.beltPct
    )} <span class="hint">(одна лента несёт ${plan.beltSpeed.toFixed(2)}/сек — это ${machinesPerBeltText(i.machinesPerBelt)})</span>${
      throttleHintHTML(i, plan)
    }${feedRecipeFuelSplitHTML(key, plan)}${btn}</li>`;
  }

  // «Лента кормит 7 заводов полностью и ещё один на половину» — но если в группе
  // стоит 8 машин, то восьмая как раз и есть та половина. Про это уже сказано в
  // шапке группы, поэтому на самой строке повторяем только когда у ЭТОЙ строки
  // своя ёмкость (её ограничивает не самый узкий ресурс группы).
  function throttleHintHTML(i, plan) {
    if (!i || !i.throttled || i.lastMachinePct == null) return "";
    if (plan && Math.abs(i.machinesPerBelt - plan.cap) < 1e-9) return "";
    return ` <span class="hint">(в группе ${i.groupMachines} ${pluralMachines(i.groupMachines)}: последний берёт ${i.lastMachinePct.toFixed(
      0
    )}% нормы)</span>`;
  }

  // Two resources on ONE belt, one on each edge - half a belt each. Кнопка у
  // каждого ресурса теперь ОДНА и та же — «Полная лента этого ресурса»: она
  // разбивает пару (ресурс поедет своей лентой), пересобирает группы и
  // пересчитывает цепочку так, чтобы ресурс занимал ЦЕЛУЮ ленту, а не половинку.
  function feedPairBoxHTML(pair, plan, nodeId) {
    const rows = pair
      .map((key) => {
        const i = plan.info[key];
        const btn = feedLineAlreadyFull(key, plan) ? "" : ` ${fullBeltResourceLineButtonHTML(nodeId, key, true)}`;
        return `<li>${feedResourceLabel(key, plan)}: <b>${i.perGroup.toFixed(2)}/сек</b> на группу${feedTotalHintHTML(i, plan)} → своя сторона ${beltFillBarHTML(
          i.lanePct
        )} <span class="hint">(сторона несёт ${plan.laneSpeed.toFixed(2)}/сек — это ${machinesPerBeltText(i.machinesPerLane)})</span>${
          throttleHintHTML(i, plan)
        }${feedRecipeFuelSplitHTML(key, plan)}${btn}</li>`;
      })
      .join("");
    return (
      `<div class="beltGroupBox inner">` +
      `<div class="beltGroupBoxHead"><span class="beltGroupBoxLabel">Общая лента · 2 ресурса по краям (по стороне на каждый)</span></div>` +
      `<ul class="beltList">${rows}</ul>` +
      `</div>`
    );
  }

  // The stage's whole input section, built around the output-belt block.
  // Manual group size: type a number + Enter → groups are rebuilt around it.
  // Empty + Enter → back to the automatic split.
  function feedGroupSizeInputHTML(nodeId, plan) {
    return (
      `<span class="feedSizeBox">заводов в группе: ` +
      `<input type="text" inputmode="numeric" class="feedGroupInput" data-node="${nodeId}" value="${plan.override || ""}" placeholder="${
        plan.maxGroup
      }" title="Своё число заводов в группе — Enter пересчитает разбиение. Пустое поле + Enter — вернуть автоматическое. Ввод очищает поле «групп»." />` +
      ` или групп: ` +
      `<input type="text" inputmode="numeric" class="feedGroupInput feedGroupCountInput" data-node="${nodeId}" value="${
        plan.overrideGroups || ""
      }" placeholder="${
        plan.numGroups
      }" title="Своё число групп — Enter поделит заводы поровну. Пустое поле + Enter — вернуть автоматическое. Ввод очищает поле «заводов в группе»." />` +
      `</span>`
    );
  }

  function renderStageFeedSection(n) {
    const plan = computeFeedPlan(n);
    if (!plan) return "";
    if (!plan.hasSolids) return renderOutputOnlyGroupsHTML(n, plan);

    // How the groups sit relative to the output belt.
    const blockNote = !plan.usesOutputBelt
      ? `На выходе жидкость/газ — лент выхода нет, группы ограничивает только подача.`
      : plan.alignPriority === "out"
      ? `Приоритет — выход: группы нарезаны по блокам выгрузки${
          plan.outBlocks > 1
            ? ` (<b>${plan.outBlocks}</b> ${pluralBlocks(plan.outBlocks)} по <b>${plan.outBlockMachines}</b> ${pluralMachines(
                plan.outBlockMachines
              )})`
            : ""
        }, поэтому каждая группа кормится своими лентами.`
      : plan.outBlocks > 1
      ? `Выход уходит на <b>${plan.outBlocks}</b> ${pluralBlocks(plan.outBlocks)} по <b>${plan.outBlockMachines}</b> ${pluralMachines(
          plan.outBlockMachines
        )} — это про выгрузку. Группы подачи считаются по потоку сырья, поэтому одна входная лента может подавать сразу несколько блоков выхода (кнопка «Приоритет» у «Выхода» нарежет подачу по блокам).`
      : `Одна лента выхода собирает <b>${plan.outBlockMachines}</b> ${pluralMachines(
          plan.outBlockMachines
        )} — на подачу это не влияет: группы считаются по потоку сырья.`;

    const evenNote =
      plan.numGroups > 1
        ? plan.minGroup === plan.maxGroup
          ? ` Все группы одинаковые — по <b>${plan.maxGroup}</b> ${pluralMachines(plan.maxGroup)}.`
          : ` Размеры групп: <b>${plan.sizeSummary}</b>${sizeLegend(plan.sizeSummary)} ${
              plan.maxGroup - plan.minGroup === 1
                ? `<span class="hint">(разница в 1 завод — ровнее уже не разделить)</span>`
                : `<span class="hint">(группы разной величины: их задают блоки выхода — одному блоку нужно больше заводов, другому меньше)</span>`
            }.`
        : "";

    // Manual size: say plainly what it did and how to get back.
    const evenTip =
      plan.evenSuggestion && plan.evenSuggestion !== plan.override
        ? ` Ровно поделится, если ввести <b>${plan.evenSuggestion}</b> — тогда группы выйдут одинаковыми.`
        : "";
    const overrideNote = plan.overrideGroups
      ? plan.overrideTooBig
        ? `<div class="beltGroupNote warn">Запрошено групп: <b>${plan.overrideGroups}</b>, но лентами столько заводов в группе не накормить — максимум <b>${plan.autoCap}</b> в группе. Считаю по максимуму; очисти поле «групп» и нажми Enter, чтобы вернуть автоматическое разбиение.</div>`
        : `<div class="beltGroupNote alt">Число групп задано вручную: <b>${plan.overrideGroups}</b> → <b>${
            plan.sizeSummary
          }</b>${sizeLegend(plan.sizeSummary)}.${
            plan.numGroups !== plan.overrideGroups
              ? ` Получилось <b>${plan.numGroups}</b> ${pluralGroups(plan.numGroups)}: ${
                  plan.overrideGroups > plan.totalMachines
                    ? `больше групп, чем заводов (${plan.totalMachines}), не бывает`
                    : `блоки выхода не делятся на группы, меньшие одной`
                }.`
              : ""
          } Очисти поле и нажми Enter — вернётся автоматическое разбиение.</div>`
      : plan.overrideTooBig
      ? `<div class="beltGroupNote warn">Запрошено <b>${plan.override}</b> ${pluralMachines(
          plan.override
        )} в группе, но лентами столько не накормить — максимум <b>${plan.autoCap}</b>. Считаю по максимуму; очисти поле и нажми Enter, чтобы вернуть автоматическое разбиение.</div>`
      : plan.override
      ? `<div class="beltGroupNote alt">Размер группы задан вручную: <b>${plan.override}</b> ${pluralMachines(plan.override)} → <b>${
          plan.sizeSummary
        }</b>${sizeLegend(plan.sizeSummary)}.${evenTip} Очисти поле и нажми Enter — вернётся автоматическое разбиение.</div>`
      : "";

    // Why this belt scheme and not the other one (only when we chose it ourselves).
    const alt = plan.runnerUp;
    const altNote =
      alt && !plan.override
        ? `<div class="beltGroupNote alt">${
            plan.pairs.length
              ? `Пара по краям одной ленты выгоднее: <b>${plan.totalBelts} ${pluralBelts(plan.totalBelts)}</b> на ${plan.numGroups} ${pluralGroups(
                  plan.numGroups
                )} против <b>${alt.totalBelts} ${pluralBelts(alt.totalBelts)}</b> на ${alt.numGroups} ${pluralGroups(alt.numGroups)} при раздельных лентах.`
              : `Раздельные ленты выгоднее: <b>${plan.totalBelts} ${pluralBelts(plan.totalBelts)}</b> на ${plan.numGroups} ${pluralGroups(
                  plan.numGroups
                )} против <b>${alt.totalBelts} ${pluralBelts(alt.totalBelts)}</b> на ${alt.numGroups} ${pluralGroups(
                  alt.numGroups
                )}, если пустить 2 ресурса по краям одной ленты.`
          }</div>`
        : "";

    // «Как есть»: если в группе больше заводов, чем лента кормит на полную, так и
    // пишем — лента кормит 7 полностью и один на половину, поэтому восьмой
    // завод в группе берёт остаток.
    const throttleNote =
      plan.maxGroup > plan.cap + 1e-9
        ? `<div class="beltGroupNote alt">В группе <b>${plan.maxGroup}</b> ${pluralMachines(
            plan.maxGroup
          )}, а лента кормит <b>${machinesPerBeltText(plan.cap)}</b> — последний завод берёт остаток ленты.</div>`
        : "";

    // Топливо печей считается отдельно от рецепта и складывается с ним, если это
    // один и тот же ресурс: у «Раскалённого кокса» уголь идёт и в рецепт, и в
    // топку, поэтому в потребности он стоит суммой.
    const fuelKeyLocal = plan.fuelKey;
    const fuelSplit = fuelKeyLocal && plan.inputSplit ? plan.inputSplit[fuelKeyLocal] : null;
    const fuelNote =
      fuelKeyLocal && fuelSplit
        ? `<div class="beltGroupNote alt">Топливо: <b>${keyDisplayName(state.dataset, fuelKeyLocal)}</b> — это «на работу печи + в рецепт». ${
            fuelSplit.recipe > 0
              ? `Здесь он идёт и туда, и туда: <b>${(fuelSplit.recipe + fuelSplit.fuel).toFixed(2)}/сек</b> всего = ${fuelSplit.recipe.toFixed(
                  2
                )} в рецепт + ${fuelSplit.fuel.toFixed(2)} в топку печей.`
              : `Печи сжигают его отдельно от рецепта: <b>${fuelSplit.fuel.toFixed(2)}/сек</b>.`
          }</div>`
        : "";

    const soloRows = plan.soloKeys.length
      ? `<ul class="beltList">${plan.soloKeys.map((k) => feedSoloLineHTML(k, plan, n.id)).join("")}</ul>`
      : "";
    const pairBoxes = plan.pairs.map((p) => feedPairBoxHTML(p, plan, n.id)).join("");
    // Манипуляторы на вход: своя строка НА КАЖДУЮ входную ленту (поток) и число
    // на один завод. Пара ресурсов по краям одной ленты — это ОДИН манипулятор:
    // он берёт с ленты оба ресурса, поэтому поток считается их суммой.
    const inserterRow = (() => {
      const streams = stageInserterStreams(n, "in", plan);
      const note = plan.pairs.length
        ? "пара по краям ленты берётся одним манипулятором — он снимает оба ресурса"
        : "";
      return inserterPickerHTML(n.id, "in", streams, note);
    })();

    const inner =
      `<div class="beltGroupNote">Групп подачи: <b>${plan.numGroups}</b>${
        plan.numGroups > 1 ? "" : ` (одна группа вмещает до ${plan.maxGroup} ${pluralMachinesGen(plan.maxGroup)})`
      }.${evenNote} ${blockNote} На группу — <b>${plan.beltsPerGroup} ${pluralBelts(plan.beltsPerGroup)}</b>, всего на этап <b>${plan.totalBelts} ${pluralBelts(
        plan.totalBelts
      )}</b>.</div>` +
      throttleNote +
      fuelNote +
      overrideNote +
      altNote +
      pairBoxes +
      soloRows;

    const head = plan.minGroup === plan.maxGroup ? `по ${plan.maxGroup} ${pluralMachines(plan.maxGroup)}` : `${plan.sizeSummary} ${pluralMachines(plan.maxGroup)}${sizeLegend(plan.sizeSummary)}`;
    return (
      `<div class="beltGroupBox">` +
      `<div class="beltGroupBoxHead"><span class="beltGroupBoxLabel">Группы подачи · ${plan.numGroups} ${pluralGroups(
        plan.numGroups
      )} ${head}</span>${feedGroupSizeInputHTML(n.id, plan)}</div>` +
      inner +
      `<div class="beltGroupBoxFoot">` +
      inserterRow +
      `</div>` +
      `</div>`
    );
  }

  // Этап без твёрдых входов: сырьё идёт по трубам, групп подачи нет. Заводы делятся на группы по выходу — сколько их
  // выгружает на одну ленту, — и размер группы можно задать вручную, как у обычной карточки.
  function renderOutputOnlyGroupsHTML(n, plan) {
    const head =
      plan.minGroup === plan.maxGroup
        ? `по ${plan.maxGroup} ${pluralMachines(plan.maxGroup)}`
        : `${plan.sizeSummary} ${pluralMachines(plan.maxGroup)}${sizeLegend(plan.sizeSummary)}`;
    const blocks =
      plan.outBlocks > 1
        ? `Выход уходит на <b>${plan.outBlocks}</b> ${pluralBlocks(plan.outBlocks)} по <b>${plan.outBlockMachines}</b> ${pluralMachines(
            plan.outBlockMachines
          )}: одна лента несёт ${plan.beltSpeed.toFixed(0)}/сек, весь выход этапа больше.`
        : `Весь выход этапа помещается на одну ленту (${plan.beltSpeed.toFixed(0)}/сек).`;
    const manual = plan.overrideGroups
      ? `<div class="beltGroupNote alt">Число групп задано вручную: <b>${plan.overrideGroups}</b> → <b>${
          plan.sizeSummary
        }</b>${sizeLegend(plan.sizeSummary)}.${
          plan.numGroups !== plan.overrideGroups
            ? ` Получилось <b>${plan.numGroups}</b> ${pluralGroups(plan.numGroups)}: блоки выхода не делятся на группы, меньшие одной, а групп больше, чем заводов (${plan.totalMachines}), не бывает.`
            : ""
        } Очисти поле и нажми Enter — вернётся автоматическое разбиение.</div>`
      : plan.overrideTooBig
      ? `<div class="beltGroupNote warn">Запрошено <b>${plan.override}</b> ${pluralMachines(
          plan.override
        )} в группе — больше, чем влезает на одну ленту выхода. Очисти поле и нажми Enter, чтобы вернуть автоматическое разбиение.</div>`
      : plan.override
      ? `<div class="beltGroupNote alt">Размер группы задан вручную: <b>${plan.override}</b> ${pluralMachines(plan.override)} → <b>${
          plan.sizeSummary
        }</b>${sizeLegend(plan.sizeSummary)}. Очисти поле и нажми Enter — вернётся автоматическое разбиение.</div>`
      : "";
    return (
      `<div class="beltGroupBox">` +
      `<div class="beltGroupBoxHead"><span class="beltGroupBoxLabel">Группы по выходу · ${plan.numGroups} ${pluralGroups(
        plan.numGroups
      )} ${head}</span>${feedGroupSizeInputHTML(n.id, plan)}</div>` +
      `<div class="beltGroupNote">Твёрдых входов нет — сырьё приходит по трубам, лент подачи не нужно. ${blocks}</div>` +
      manual +
      `</div>`
    );
  }

  // Enter in the "заводов в группе" field: commit a manual size (or clear it).
  function commitFeedGroupSize(input) {
    const nodeId = input.dataset.node;
    const treeNode = findTreeNodeById(state.cascade.root, nodeId);
    if (!treeNode) return;
    const byCount = input.classList && input.classList.contains("feedGroupCountInput");
    const raw = (input.value || "").trim();
    const stageMachines = (() => {
      const res = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
      return res && res.machines ? Math.max(1, Math.ceil(res.machines - 1e-9)) : null;
    })();
    if (!raw) {
      // empty → back to the automatic split (only the field that was cleared)
      delete treeNode[byCount ? "feedGroupCount" : "feedGroupSize"];
    } else {
      const parsed = parseFloat(raw.replace(",", "."));
      const value = Math.floor(parsed);
      if (!isFinite(parsed) || value < 1) {
        showErrorBanner(`Нужно целое число не меньше 1 — «${raw}» не подходит.`);
        return;
      }
      let accepted = value;
      if (stageMachines && value > stageMachines) {
        // групп не больше, чем заводов, и группа не больше всего этапа
        accepted = stageMachines;
        showErrorBanner(
          byCount
            ? `Групп не может быть больше, чем заводов на этапе (${stageMachines}) — поставил ${stageMachines}.`
            : `В группе не может быть больше заводов, чем на этапе (${stageMachines}) — поставил ${stageMachines}.`
        );
      }
      // Одно из двух: ввод числа групп очищает «заводов в группе» и наоборот
      if (byCount) {
        treeNode.feedGroupCount = accepted;
        delete treeNode.feedGroupSize;
      } else {
        treeNode.feedGroupSize = accepted;
        delete treeNode.feedGroupCount;
      }
    }
    // Group sizing is a layout decision, not a throughput one - the solve is
    // unchanged, so we just redraw.
    saveCurrentTabSnapshot();
    state.dirty = true;
    renderResults();
  }

  function pluralResources(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "ресурс";
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "ресурса";
    return "ресурсов";
  }

  // Rescales the WHOLE chain's target rate so this one node's machine count
  // becomes a whole number that fills this resource's belt as close to full
  // capacity as possible without going over (can't have more than a belt's
  // worth flowing, so round DOWN to the nearest amount an integer number of
  // machines actually produces/consumes).
  // Ingredients/products come straight from the backend result; fuel and its
  // burnt result (ash) don't - they're computed client-side. Look in all
  // three places so "Полная лента" works for every kind of belt line.
  //
  // `direction` says which line the button belongs to: an item can be BOTH an
  // ingredient and a product of the same recipe (ash is consumed by
  // py's kicalk-3-saline and produced by anything burning coal), and reading
  // the input figure for an output line scales the chain by an unrelated
  // number. `machine` used to be read before it was declared - a fuel/ash line
  // threw ReferenceError instead of recalculating anything.
  function getNodeItemRate(node, treeNode, key, direction) {
    const first = direction === "out" ? [node.products, node.ingredients] : [node.ingredients, node.products];
    for (const table of first) {
      if (table && table[key] != null) return table[key];
    }
    const machine = (state.dataset.entities || {})[node.machineName];
    if (treeNode && machine && treeNode.fuelItem && fuelKind(machine) === "item") {
      const fuelItem = fuelEntry(state.dataset, machine, treeNode.fuelItem);
      const fuelRate =
        fuelConsumptionPerMachine(machine, fuelItem, effectsWithMachineBase(treeNode, machine).consumption) * node.machines;
      if (key === itemKey("item", treeNode.fuelItem)) return fuelRate;
      if (fuelItem && fuelItem.burnt_result && key === itemKey("item", fuelItem.burnt_result)) return fuelRate;
    }
    return null;
  }

  /** «Полная лента этого ресурса» (кнопка во входе у каждого ресурса).
   *
   *  Делает три вещи по порядку:
   *    1. раскладка — ресурс едет СВОЕЙ лентой: если он делил ленту с соседом
   *       (пара по краям), пара разбивается, а группы подачи пересобираются
   *       заново (выбор сохраняется в цепочке: `soloFeedKeys` на узле);
   *    2. масштаб — его потребность на этом этапе становится ровно одной лентой
   *       (дробное число заводов, как и везде: «7 заводов и ещё один на
   *       половину»);
   *    3. пересчёт — вся цепочка и ВСЕ вкладки этого рецепта (recalcChainAndTabs).
   *
   *  Ресурс при этом считается по ПОТОКУ ленты: своя лента несёт belt.speed/сек,
   *  значит заводов встанет ровно столько, сколько нужно на эту скорость.
   */
  async function applyFullBeltTargetInput(nodeId, key) {
    const solved = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
    if (!solved || !(solved.machines > 0)) return;
    const treeNode = findTreeNodeById(state.cascade && state.cascade.root, nodeId);
    if (!treeNode) return;
    // Потребность этапа: рецепт + топка (топливо едет по той же ленте).
    const rate = stageSolidInputs(solved, state.cascade.root)[key];
    if (!(rate > 0)) return;

    // 1. Ресурс едет своей лентой: пара разбивается, группы пересобираются.
    const solo = Array.isArray(treeNode.soloFeedKeys) ? treeNode.soloFeedKeys.slice() : [];
    if (!solo.includes(key)) solo.push(key);
    treeNode.soloFeedKeys = solo;

    // 2. Масштаб: потребность этого ресурса на этапе = ровно одна полная лента.
    const perMachine = rate / solved.machines;
    const idealMachines = state.belt.speed / perMachine;
    const scaleFactor = idealMachines / solved.machines;
    if (scaleFactor > 0 && isFinite(scaleFactor)) {
      state.cascade.targetRate = state.cascade.targetRate * scaleFactor;
    }

    // 3. Пересчёт всей цепочки и всех вкладок этого рецепта.
    await recalcChainAndTabs(false);
  }

  // «Полная лента (весь выход)» - the stage's whole solid output rides ONE belt
  // as a single mixed stream, so we rescale the chain until that combined stream
  // fills one full belt. That count is the BELT's throughput divided by what one
  // machine puts out (see computeCombinedOutputPlan): the stream can be spread
  // over both lanes (an inserter per lane, or lanes merged), so the belt's total
  // speed is the limit - NOT 2 × floor(lane / perMachine), which called 4 machines
  // a "full belt" while the belt was only 71% full (Крахмал: 5 machines fit).
  // Ash from burnt fuel is counted here ONLY when the person asked for it
  // (combinedOutputItems), otherwise it leaves on its own line.
  async function applyFullBeltTargetOutput(nodeId) {
    const node = state.lastResult && state.lastResult.nodes[nodeId];
    if (!node || !node.machines) return;
    const plan = computeCombinedOutputPlan(combinedOutputItems(node), node.machines);
    if (!plan || !(plan.perMachineTotal > 0)) return;
    // The plan's machinesPerBelt IS that count; when one machine overruns a belt
    // the best we can do is a single machine (and the card says it needs several
    // belts anyway).
    const idealMachines = plan.oneMachineNeedsMultipleBelts ? 1 : plan.machinesPerBelt;
    if (!(idealMachines > 0)) return;
    const scaleFactor = idealMachines / node.machines;
    if (!(scaleFactor > 0) || !isFinite(scaleFactor)) return;
    state.cascade.targetRate = state.cascade.targetRate * scaleFactor;
    await recalcChainAndTabs(false);
  }

  // Пересчитать масштаб цепочки так, чтобы заданное число заводов стало текущим
  async function recalcNodeMachines(nodeId) {
    const input = document.querySelector(`.machinesInput[data-node="${CSS.escape(nodeId)}"]`);
    if (!input) return;
    const v = parseInt(input.value, 10);
    if (!isFinite(v) || v <= 0) {
      alert('Введите корректное целое число заводов (>=1)');
      return;
    }
    const node = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
    if (!node) return;
    const origMachines = node.machines;
    if (!isFinite(origMachines) || origMachines <= 0) {
      alert('Текущий расчёт не содержит информацию о количестве заводов, пересчёт невозможен.');
      return;
    }
    const scaleFactor = v / origMachines;
    if (!(scaleFactor > 0) || !isFinite(scaleFactor)) return;
    state.cascade.targetRate = state.cascade.targetRate * scaleFactor;
    await runSolve();
    saveCurrentTabSnapshot();
    // If this active tab is part of a group, use this node's actual output
    // for the group's item as the new group target and redistribute so other
    // members match (user expects editing a member to set the group's rate).
    try {
      const activeTab = calcTabs[activeTabIndex];
      if (activeTab && activeTab.groupId && tabGroups[activeTab.groupId]) {
        const groupId = activeTab.groupId;
        const group = tabGroups[groupId];
        // Primary group item key (what the group as a whole makes)
        const itemKey = group.itemKey;
        // How much of that item this node now produces (per second)
        const nodeRes = state.lastResult && state.lastResult.nodes && state.lastResult.nodes[nodeId];
        const produced = nodeRes && nodeRes.products && (nodeRes.products[itemKey] || 0);
        const newTarget = produced > 1e-12 ? produced : computeGroupTotal(groupId);
        tabGroups[groupId].targetTotal = newTarget;
        await redistributeGroup(groupId, newTarget);
      }
    } catch (e) {
      // ignore redistribution errors and continue with descendant recalcs
    }
    await recalcDescendantTabs(calcTabs[activeTabIndex].id);
    await settleChainNet(calcTabs[activeTabIndex].id);
    renderResults();
    renderInputResources();
  }

  // Button placed inside a shared-belt group box (two resources, one per lane).
  // Encodes the group's resource keys so the handler can rescale the whole
  // chain by whichever of them currently occupies its lane the most.
  function groupFullBeltButtonHTML(keys) {
    if (!keys || keys.length < 2) return "";
    return `<button type="button" class="fullBeltGroupBtn" data-keys="${keys.join(
      "|"
    )}" title="Пересчитать все цепочки и вкладки так, чтобы самый занятый ресурс этой общей ленты занял свою сторону ровно целиком (по его суммарной потребности, без перелива стороны)">Полная лента для группы</button>`;
  }

  // Total demand of one raw resource across the whole chain - the same merge the
  // «Входящие ресурсы» panel shows (raw inputs + fuel).
  function chainRawInputRate(key) {
    let rate = 0;
    if (state.lastResult && state.lastResult.rawInputs && state.lastResult.rawInputs[key] != null) {
      rate = state.lastResult.rawInputs[key];
    }
    rate += computeFuelInputs()[key] || 0;
    return rate;
  }

  // «Полная лента этого ресурса» в панели «Входящие ресурсы»: ресурс принадлежит
  // всей цепочке, поэтому масштабируем цепочку так, чтобы его СУММАРНАЯ
  // потребность стала целым числом лент (остаток получает свою ПОЛНУЮ ленту, а не
  // половинку на пару с соседом — тогда он и в раскладке перестаёт делиться).
  async function applyFullBeltTargetResource(key) {
    const rate = chainRawInputRate(key);
    if (!(rate > 0)) return;
    // Разбиваем пару, если она стояла вручную (перетаскиванием): ресурс поедет
    // своей лентой и получит её целиком.
    const partner = state.inputPairs[key];
    if (partner) {
      delete state.inputPairs[key];
      if (state.inputPairs[partner] === key) delete state.inputPairs[partner];
    }
    const capacity = state.belt.speed;
    const fullBelts = Math.floor(rate / capacity + 1e-9);
    const leftover = rate - fullBelts * capacity;
    const targetRate = leftover > 1e-9
      ? (fullBelts + 1) * capacity // остаток получает целую ленту — и едет один
      : Math.max(capacity, rate); // уже целые ленты — ничего не меняем
    const scaleFactor = targetRate / rate;
    if (!(scaleFactor > 0) || !isFinite(scaleFactor)) return;
    state.cascade.targetRate = state.cascade.targetRate * scaleFactor;
    await recalcChainAndTabs(false);
  }

  // «Полная лента для группы» - two (or more) resources ride ONE shared belt,
  // one per lane. Rescale the WHOLE chain (and any dependent tabs) so that the
  // busiest of them fills its lane exactly.
  //
  // This used to derive the factor from ONE consumer node
  // (floor(target / perMachineOfThatNode) / itsMachines). A resource consumed by
  // several nodes with different per-machine rates made that factor overshoot:
  // coal 4/sec split over two nodes (2 machines x 0.5 + 3 x 1) asked for a
  // 7.5/sec lane and got 9.33/sec - 124% of the lane, i.e. exactly the backing-up
  // belt the button is supposed to prevent. The honest factor is simply
  // target/current, which lands ON the lane; machine counts stay fractional,
  // exactly like everywhere else in this calculator.
  async function applyFullBeltTargetGroup(keys) {
    if (!state.lastResult || !state.lastResult.nodes || !keys || !keys.length) return;
    const fullBeltCapacity = state.belt.speed; // both lanes
    const laneSpeed = state.belt.speed / 2; // one side
    if (!(laneSpeed > 0)) return;

    // Total demand per resource (raw inputs + fuel), same merge the list shows.
    const merged = new Map(Object.entries(state.lastResult.rawInputs || {}));
    for (const [k, v] of Object.entries(computeFuelInputs())) merged.set(k, (merged.get(k) || 0) + v);

    // Busiest = the resource occupying the most of its lane right now. The
    // shared belt only carries each resource's LEFTOVER (whatever doesn't fill
    // a whole dedicated belt), so we compare by that leftover, not the total.
    let busiest = null;
    for (const key of keys) {
      const rate = merged.get(key) || 0;
      if (rate <= 0) continue;
      const fullBelts = Math.floor(rate / fullBeltCapacity + 1e-9);
      const leftover = rate - fullBelts * fullBeltCapacity;
      if (!busiest || leftover > busiest.leftover) busiest = { key, rate, fullBelts, leftover };
    }
    if (!busiest) return;

    // Keep whatever whole belts that resource already fills and top its last
    // (shared) lane up to full: shifting every resource by the same factor.
    const targetRate = busiest.fullBelts * fullBeltCapacity + laneSpeed;
    const scaleFactor = targetRate / busiest.rate;
    if (!(scaleFactor > 0) || !isFinite(scaleFactor)) return;

    state.cascade.targetRate = state.cascade.targetRate * scaleFactor;
    await recalcChainAndTabs(false);
  }

  // Enter on a fluid/gas rate field rescales the whole chain so that fluid
  // reaches the entered value, then re-solves - the same trick the belt
  // buttons use. Every rate scales linearly with the target, so the factor is
  // simply entered/current, whichever fluid (input or output) was edited.
  async function commitFluidRateEdit(inp) {
    const currentPerSec = parseFloat(inp.dataset.persec);
    const unit = inp.dataset.unit === "min" ? "min" : "sec";
    const entered = parseFloat((inp.value || "").replace(",", ".").trim());
    if (!(entered > 0) || !(currentPerSec > 0)) return;
    const enteredPerSec = unit === "min" ? entered / 60 : entered;
    const scaleFactor = enteredPerSec / currentPerSec;
    if (!(scaleFactor > 0) || !isFinite(scaleFactor) || Math.abs(scaleFactor - 1) < 1e-9) return;
    state.cascade.targetRate = state.cascade.targetRate * scaleFactor;
    await recalcChainAndTabs(false);
  }

  // Lay out the input-resource lines, wrapping any two resources that share a
  // single belt (one per lane) into a rounded box with a group-level «Полная
  // лента для группы» button. Every resource keeps its original order; the box
  // just appears where the first of the pair sits and draws its partner in
  // beside it. `partnerOf(key)` returns the key sharing a belt with `key` (or
  // null), and `renderLine(key)` renders one resource's own line.
  function buildInputResLines(orderedKeys, partnerOf, renderLine) {
    const done = new Set();
    const out = [];
    for (const key of orderedKeys) {
      if (done.has(key)) continue;
      const partner = partnerOf(key);
      if (partner && !done.has(partner) && orderedKeys.includes(partner)) {
        done.add(key);
        done.add(partner);
        const inner = renderLine(key) + renderLine(partner);
        out.push(
          `<div class="beltGroupBox">` +
            `<div class="beltGroupBoxHead"><span class="beltGroupBoxLabel">Общая лента · 2 ресурса (по стороне на каждый)</span>` +
            groupFullBeltButtonHTML([key, partner]) +
            `</div>${inner}</div>`
        );
      } else {
        done.add(key);
        out.push(renderLine(key));
      }
    }
    return out;
  }

  function pluralBelts(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "лента";
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "ленты";
    return "лент";
  }

  function pluralMachines(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "завод";
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "завода";
    return "заводов";
  }

  /** «из 1 завода», «из 4 заводов» — родительный падеж для «из N …». */
  function pluralMachinesGen(n) {
    const whole = Math.floor(n);
    const mod10 = whole % 10;
    const mod100 = whole % 100;
    return mod10 === 1 && mod100 !== 11 ? "завода" : "заводов";
  }

  function pluralModules(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "модуль";
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "модуля";
    return "модулей";
  }

  function pluralGroups(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "группа";
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "группы";
    return "групп";
  }

  function computeNodeDepths(root) {
    const depths = new Map();
    function walk(node, depth) {
      depths.set(node.id, depth);
      for (const child of Object.values(node.children || {})) walk(child, depth + 1);
    }
    if (root) walk(root, 0);
    return depths;
  }

  // ---------- modules: the little block next to the machine ----------
  //
  // [🔧 + модуль]  [icon] Скорость 3 [ 2 ]✕   [icon] Продуктивность 2 [ 2 ]✕
  // слоты: 4 / 4      итого от модулей: +85% скор · +12% прод · +200% энерг
  //
  // The count field commits on Enter (and is also read by collectResultEdits,
  // so a value typed and then abandoned isn't silently lost on the next recalc).

  function moduleChipHTML(node, inst, target, host, recipe) {
    const def = moduleDef(inst.name);
    const type = moduleTypeById(def ? def.typeId : "other");
    const label = def ? def.label : prettify(inst.name);
    const missing = !def;
    // Модуль, который завод не принимает (дамп говорит это прямо), помечаем —
    // в игре он не встанет. Ставить его всё равно можно (расчёт посчитает), но
    // человек об этом узнает сразу, а не в игре.
    const fit = def && host ? moduleFitsMachine(def, host, recipe) : { ok: true, reason: null, unknown: true };
    const doubtful = def && !fit.ok;
    const variants = def ? moduleVariants(def.name) : [];
    const swapTitle =
      variants.length > 1
        ? `Заменить на другую версию: ${variants.map((v) => v.label).join(", ")}`
        : "Других версий этого модуля в датасете нет";
    const title = missing
      ? "Этого модуля нет в датасете"
      : doubtful
      ? `⚠ ${fit.reason}. В игре такой модуль в этот завод не встанет.`
      : `${type.label} · ${moduleEffectsSummary(def.effects)}`;
    return `<span class="modChip ${missing ? "modChipMissing" : ""} ${doubtful ? "modChipDoubtful" : ""}" data-type="${
      def ? def.typeId : "other"
    }" title="${title}">
        ${doubtful ? `<span class="modWarn">⚠</span>` : ""}
        <span class="modChipMain" data-node="${node.id}" data-module="${inst.name}" data-target="${
      target || "machine"
    }" title="${swapTitle}">${
      def && def.icon ? iconImg(def.icon, 16) : `<span class="modDot mod-${def ? def.typeId : "other"}"></span>`
    }<span class="modChipName">${label}</span>${variants.length > 1 ? `<span class="modSwap">МК⇅</span>` : ""}</span>
        <input type="number" class="modQty" min="0" step="1" data-node="${node.id}" data-module="${inst.name}" data-target="${
      target || "machine"
    }" value="${Math.max(0, Math.floor(inst.count || 0))}" title="${
      isBeaconTarget(target) ? "Кол-во модулей В ЭТОМ маяке" : "Кол-во модулей на один завод"
    }. Enter — пересчитать всю цепочку" />
        <button class="modRemoveBtn" data-node="${node.id}" data-module="${inst.name}" data-target="${
      target || "machine"
    }" title="Убрать модуль">✕</button>
      </span>`;
  }

  // Клик по значку модуля: показать ВСЕ его версии (МК1…МК4) и заменить текущую.
  // Игра считает их одним модулем разных уровней, в дампе это разные предметы —
  // поэтому «повысить» модуль можно только так.
  function openModuleVariantPicker(nodeId, moduleName, target) {
    const node = findTreeNodeById(state.cascade.root, nodeId);
    if (!node) return;
    const def = moduleDef(moduleName);
    if (!def) return;
    const intoBeacon = isBeaconTarget(target);
    const list = moduleListFor(node, target) || [];
    const inst = list.find((m) => m.name === moduleName);
    if (!inst) return;
    const variants = moduleVariants(moduleName).filter((v) => !v.virtual || v.name === moduleName);
    const machine = intoBeacon
      ? beaconOfRow(beaconRows(node)[parseBeaconTarget(target)])
      : (state.dataset.entities || {})[node.machineName];
    const recipe = state.dataset.recipes[node.recipeName];
    const slots = machineModuleSlots(machine);

    const rowHTML = (v) => {
      const fit = moduleFitsMachine(v, machine, recipe);
      const current = v.name === moduleName;
      return `<div class="modOption ${current ? "modOptionCurrent" : ""} ${fit.ok ? "" : "modOptionRejected"}" data-module="${v.name}" ${
        fit.ok ? "" : `data-reject="${fit.reason}"`
      }>
        <div class="modOptionHead">${v.icon ? iconImg(v.icon, 20) : ""}<b>${v.label}</b>${
        current ? ` <span class="hint">(стоит сейчас)</span>` : ""
      }${v.tier ? ` <span class="hint">МК${v.tier}</span>` : ""}</div>
        <div class="modOptionFx">${moduleEffectsSummary(v.effects)}</div>
        ${fit.ok ? "" : `<div class="modOptionWhy">⚠ ${fit.reason}</div>`}
      </div>`;
    };

    const overlay = document.createElement("div");
    overlay.className = "modalOverlay";
    overlay.innerHTML = `<div class="modalPanel">
        <div class="modalHeader">Версии модуля «${def.label}» <button class="modalClose">✕</button></div>
        <p class="hint">В игре это один модуль разных уровней (МК1…МК4). Нажми версию, чтобы заменить — количество
          (${Math.max(0, Math.floor(inst.count || 0))}${slots != null ? ` из ${slots} слотов` : ""}) сохранится.
          Эффекты считаются по данным модуля, так что расчёт сразу пересчитается.</p>
        <div class="modalBody modPickerBody">
          <div class="modGroup"><div class="modGroupHead"><span class="modDot mod-${def.typeId}"></span>${moduleTypeById(
      def.typeId
    ).label}</div><div class="modGroupItems">${variants.map(rowHTML).join("")}</div></div>
        </div>
        <div class="modalFooter"><button class="modalClose btn btn-ghost">Закрыть</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelectorAll(".modalClose").forEach((b) => b.addEventListener("click", close));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        close();
        return;
      }
      const opt = e.target.closest(".modOption");
      if (!opt) return;
      if (opt.classList.contains("modOptionRejected")) {
        safeCall(() => showErrorBanner(opt.dataset.reject || "Этот модуль не встанет в завод"));
        return;
      }
      const newName = opt.dataset.module;
      if (!newName) return;
      inst.name = newName;
      close();
      safeCall(recalcResults);
    });
  }

  // ---------- Маяки: раздел внизу страницы ----------
  //
  // Строка — это ОДИН маяк: [этап] [тип маяка] [покрывает заводов] [что в нём
  // вставлено] [✕]. Строк на этап может быть сколько угодно, и каждая — свой
  // слой маяков: до каждого завода достаёт столько маяков, сколько строк у его
  // этапа (см. BEACONS выше). Поэтому «сколько маяков достаёт до фабрики» больше
  // не вводится руками — это просто число строк.

  // Every node in the tree that actually has a recipe/machine on it (i.e.
  // every stage card), in the same top-to-bottom order the tree is walked.
  function listBeaconFactoryCandidates() {
    const list = [];
    if (state.cascade.root) {
      walkTree(state.cascade.root, (node) => {
        if (node.recipeName) list.push(node);
      });
    }
    return list;
  }

  /** Иконка этапа в списке маяков: рецепт, а без неё завод. */
  function beaconFactoryIcon(node) {
    const recipe = state.dataset.recipes[node.recipeName];
    const machine = (state.dataset.entities || {})[node.machineName];
    return recipeIconUrl(recipe) || machineIconUrl(machine) || "";
  }

  function beaconFactoryLabel(node) {
    const recipe = state.dataset.recipes[node.recipeName];
    const machine = (state.dataset.entities || {})[node.machineName];
    return `${recipeDisplayName(recipe)}${machine ? " · " + machineDisplayName(machine) : ""}`;
  }

  /** Перерисовать раздел «Маяки» из модели, не дожидаясь ответа сервера.
   *
   *  Сначала забираются значения из полей (collectResultEdits), потом рисуется панель:
   *  добавленный маяк виден и тогда, когда расчёт ещё не делался или не прошёл.
   */
  function refreshBeaconsPanel() {
    collectResultEdits();
    renderBeaconsSection();
  }

  /** Добавить строку-маяк. Без адреса — первому этапу цепочки. */
  function addBeaconRow(nodeId) {
    const candidates = listBeaconFactoryCandidates();
    if (!candidates.length) {
      alert("Сначала соберите цепочку — добавлять маяки некуда.");
      return null;
    }
    const node = (nodeId && candidates.find((n) => n.id === nodeId)) || candidates[0];
    const rows = beaconRows(node);
    const beacons = datasetBeacons(state.dataset);
    rows.push({ name: beacons[0] ? beacons[0].name : null, covers: null, modules: [] });
    recomputeNodeEffects(node);
    refreshBeaconsPanel();          // строка видна сразу, а не после пересчёта
    safeCall(recalcResults);
    return node;
  }

  function removeBeaconRow(nodeId, index) {
    const node = findTreeNodeById(state.cascade.root, nodeId);
    if (!node) return;
    beaconRows(node).splice(index, 1);
    recomputeNodeEffects(node);
    refreshBeaconsPanel();
    safeCall(recalcResults);
  }

  /** Перенести строку на другой этап: она уходит от старого и появляется у нового. */
  function moveBeaconRow(oldNodeId, index, newNodeId) {
    const oldNode = findTreeNodeById(state.cascade.root, oldNodeId);
    const newNode = findTreeNodeById(state.cascade.root, newNodeId);
    if (!oldNode || !newNode || oldNode === newNode) return;
    const row = beaconRows(oldNode).splice(index, 1)[0];
    if (!row) return;
    beaconRows(newNode).push(row);
    recomputeNodeEffects(oldNode);
    recomputeNodeEffects(newNode);
    refreshBeaconsPanel();
    safeCall(recalcResults);
  }

  /** Правка маяков из раздела: применить значения из полей и сразу пересчитать.
   *
   *  Маяки меняют скорость и продуктивность заводов, а значит и их число. Панель
   *  перерисовывается до пересчёта, чтобы правка была видна, даже если сервер отвечает
   *  не сразу.
   */
  async function commitBeaconEdits() {
    collectResultEdits();      // сначала забираем значения из полей
    renderBeaconsSection();
    await recalcResults();
    return true;
  }

  /** Одна строка-маяк: что за маяк, что в нём и сколько заводов он накрывает. */
  function beaconRowHTML(node, row, index, candidates) {
    const recipe = state.dataset.recipes[node.recipeName];
    const beacons = datasetBeacons(state.dataset);
    const beacon = beaconOfRow(row) || beacons[0];
    const target = beaconTarget(index);
    const slots = machineModuleSlots(beacon);
    const usedSlots = asArray(row.modules).reduce((sum, m) => sum + Math.max(0, Math.floor(m.count || 0)), 0);
    const overSlots = slots != null && usedSlots > slots;
    const chips = asArray(row.modules).map((inst) => moduleChipHTML(node, inst, target, beacon, recipe)).join("");
    const layers = beaconLayersRange(node);
    const machines = machinesOfNode(node);
    const need = beaconsForRow(node, row);
    const covers = Number(row.covers) > 0 ? Math.floor(Number(row.covers)) : null;
    const supply = beaconSupplyArea(beacon);
    const capacity = beaconCapacity(row, machines);
    // До заводов ЭТОЙ строки достаёт от layers.min до layers.max маяков: маяки
    // размазаны по этапу, и «лишние» ложатся вторым слоем только на часть заводов.
    const transmissionMin = beacon ? beaconTransmission(beacon, Math.max(1, layers.min)) : 0;
    const transmissionMax = beacon ? beaconTransmission(beacon, Math.max(1, layers.max)) : 0;
    const transmission = layers.max > layers.min
      ? `${(transmissionMin * 100).toFixed(0)}–${(transmissionMax * 100).toFixed(0)}%`
      : `${(transmissionMax * 100).toFixed(0)}%`;

    return `
      <div class="beaconRow" data-node="${node.id}" data-row="${index}">
        <div class="beaconRowMain">
          <select class="beaconFactorySelect" data-node="${node.id}" data-row="${index}"
                  title="Этап цепочки, заводы которого накрывает этот маяк">
            ${candidates
              .map((n) => `<option value="${n.id}" data-icon="${beaconFactoryIcon(n) || ""}" ${n.id === node.id ? "selected" : ""}>${beaconFactoryLabel(n)}</option>`)
              .join("")}
          </select>
          <select class="beaconSelect" data-node="${node.id}" data-row="${index}" title="Тип маяка">
            ${beacons
              .map((b) => `<option value="${b.name}" data-icon="${machineIconUrl(b) || ""}" ${b.name === beacon?.name ? "selected" : ""}>${machineDisplayName(b)}</option>`)
              .join("")}
          </select>
          <span class="beaconLabel" title="Сколько заводов этапа накрывает ЭТОТ маяк. Пусто — весь этап. Заводы за пределами покрытия работают без прибавки">покрывает заводов:</span>
          <input type="number" class="beaconCovers" min="1" step="1" data-node="${node.id}" data-row="${index}"
                 value="${covers != null ? covers : ""}" placeholder="все"
                 title="Сколько заводов этапа накрывает этот маяк. Пусто — весь этап. Enter — пересчитать цепочку" />
          <span class="hint">${machines ? `из ${machines}` : "цепочку ещё не считали"}</span>
          <button class="addModuleBtn addBeaconModuleBtn" data-node="${node.id}" data-target="${target}" ${slots === 0 ? "disabled" : ""}
                  title="Что вставлено в ЭТОТ маяк (эффект раздаётся заводам с потерями)">🔧 + модуль</button>
          ${chips}
          <button class="beaconRowRemove" data-node="${node.id}" data-row="${index}" title="Убрать этот маяк">✕</button>
        </div>
        <div class="stageModulesInfo ${overSlots ? "modOver" : ""}">
          ${slots != null ? `модулей в маяке: ${usedSlots} / ${slots}${overSlots ? " — превышено!" : ""} · ` : ""}${
      usedSlots ? "" : "модулей нет — пустой маяк ничего не передаёт · "
    }${
      machines
        ? `накрывает <b>${capacity}</b> ${pluralMachines(capacity)} этапа · таких маяков нужно <b>${need}</b>, чтобы накрыть все ${machines} · `
        : ""
    }маяков до завода: <b>${layers.min === layers.max ? layers.min : `${layers.min}–${layers.max}`}</b> · передача <b>${transmission}</b>${
      beacon ? ` <span class="hint">(вклад одного маяка ${((beacon.distribution_effectivity ?? 0.5) * 100).toFixed(0)}%, с учётом падения от их числа)</span>` : ""
    }${supply ? ` · зона снабжения ${supply}×${supply}` : ""}
        </div>
      </div>`;
  }

  /** Заголовок этапа в разделе маяков: сколько заводов, маяков и кто под маяками. */
  function beaconStageSummaryHTML(node) {
    const plan = beaconPlanForNode(node);
    const beacon = beaconOfRow(beaconRows(node).find((row) => row && row.name));
    const fx = beaconEffects(node);
    const power = beacon ? ((beacon.energy_usage || 0) + (beacon.drain || 0)) * plan.total : 0;
    const fmt = (w) => (w >= 1e6 ? `${(w / 1e6).toFixed(2)} МВт` : `${Math.round(w / 1e3)} кВт`);
    // Сколько еще маяков нужно, чтобы накрыть весь этап: берём самую «широкую»
    // строку — по ней и понятно, чего не хватает.
    const needMore = plan.machines && plan.uncovered
      ? Math.max(0, ...plan.needed.map((n) => n - plan.rows)) : 0;
    return `<div class="beaconStageHead">
        <b>${beaconFactoryLabel(node)}</b>
        <span class="hint">заводов: ${plan.machines} · маяков: <b>${plan.total}</b>${
      plan.rows && plan.machines
        ? ` · под маяками: <b>${plan.covered}</b> из ${plan.machines}${
          plan.uncovered ? ` (${plan.uncovered} без прибавки${needMore ? `, нужно ещё ${needMore}` : ""})` : ""
        }`
        : ""
    }${power ? ` · ${fmt(power)}` : ""}${
      fx ? ` · от маяков (в среднем по этапу): ${moduleEffectsSummary(fx)}` : ""
    }</span>
        <button class="btn btn-ghost addBeaconRowBtn" data-node="${node.id}" title="Ещё один маяк на этот этап">+ маяк</button>
      </div>`;
  }

  function renderBeaconsSection() {
    const panel = document.getElementById("beaconsPanel");
    const box = document.getElementById("beaconEntriesList");
    if (!panel || !box) return;
    const addBtn = document.getElementById("addBeaconEntryBtn");
    const recalcBtn = document.getElementById("recalcBeaconsBtn");
    if (!state.dataset) {
      panel.classList.add("hidden");
      return;
    }
    const beaconTypes = datasetBeacons(state.dataset);
    if (!beaconTypes.length) {
      panel.classList.add("hidden"); // dump has no beacon entities at all
      return;
    }
    panel.classList.remove("hidden");
    if (!state.cascade.root) {
      box.innerHTML = `<p class="hint msg">Соберите цепочку, чтобы добавлять маяки на её заводы.</p>`;
      if (addBtn) addBtn.disabled = true;
      if (recalcBtn) recalcBtn.disabled = true;
      return;
    }
    if (addBtn) addBtn.disabled = false;
    if (recalcBtn) recalcBtn.disabled = false;
    const candidates = listBeaconFactoryCandidates();
    // Показываем КАЖДЫЙ этап: у каждого свой заголовок и своя кнопка «+ маяк»,
    // чтобы строку можно было добавить сразу к нужному этапу, а не переставлять
    // её потом выпадающим списком.
    box.innerHTML = candidates
      .map((node) => {
        const rows = beaconRows(node);
        const body = rows.length
          ? rows
              .map((row, index) => (row && row.name ? beaconRowHTML(node, row, index, candidates) : ""))
              .join("")
          : `<p class="hint msg">Маяков нет. «+ маяк» добавит строку: тип маяка, что в него вставить и сколько заводов он накрывает.</p>`;
        return `<div class="beaconStage">${beaconStageSummaryHTML(node)}${body}</div>`;
      })
      .join("");
  }

  // Beacons are power hogs (a vanilla beacon draws 480 kW, and Pyanodon's pulls
  // 1 MW plus 1 MW of drain). We deliberately do NOT fold this into the machine's
  // power: one beacon usually serves several machines, and we have no idea how
  // your build is laid out - claiming a number would be worse than showing it
  // separately with that caveat.
  function beaconPowerHTML(beacon, count) {
    const per = (beacon.energy_usage || 0) + (beacon.drain || 0);
    if (!per || !count) return "";
    const total = per * count;
    const fmt = (w) => (w >= 1e6 ? `${(w / 1e6).toFixed(2)} МВт` : `${Math.round(w / 1e3)} кВт`);
    return `<br /><span class="hint">мощность маяков: ${count} × ${fmt(per)} = ${fmt(
      total
    )} на завод — в мощность завода не включено (маяк обычно обслуживает несколько заводов)</span>`;
  }

  /** Строки маяков этапа в виде, который ждёт сундук запроса: что и сколько купить.
   *
   *  В чертёж блока они не входят. Маяков ровно по одному на строку; `covers` нужен серверу
   *  для закупки и подписи (сколько заводов этапа накрывает маяк).
   */
  function beaconPayloadForNode(node) {
    const rows = beaconRows(node).filter((row) => row && row.name);
    return rows
      .map((row) => ({
        name: row.name,
        count: 1,
        covers: Number(row.covers) > 0 ? Math.floor(Number(row.covers)) : null,
        modules: asArray(row.modules)
          .filter((m) => m && m.name && Math.floor(m.count || 0) > 0)
          .map((m) => ({ name: m.name, count: Math.max(0, Math.floor(m.count || 0)) })),
      }))
      .filter((row) => row.count > 0);
  }

  function modulesBlockHTML(node, machine, recipe, totalEffects) {
    const slots = machineModuleSlots(machine);
    const used = moduleCountOnNode(node);
    const over = slots != null && used > slots;
    const chips = (node.modules || []).map((inst) => moduleChipHTML(node, inst, "machine", machine, recipe)).join("");
    // total = manual + machine modules + beacons; this line is about the machine's
    // own modules, so back the other two out.
    const fromModules = { ...totalEffects };
    const man = node.manualEffects || {};
    const fromBeacons = beaconEffects(node) || {};
    for (const k of MODULE_EFFECT_KEYS) {
      fromModules[k] = (fromModules[k] || 0) - (man[k] || 0) - (fromBeacons[k] || 0);
    }
    // The machine may come with a bonus baked in (Electromagnetic plant: +50%
    // prod). The solver adds it on top of everything below; show it so the
    // numbers aren't mysterious.
    const base = machineBaseEffect(machine);
    const baseLine = base
      ? `<div class="stageModulesInfo stageBaseEffect" title="Собственный бонус завода, без всяких модулей — учитывается в расчёте">сам завод: ${moduleEffectsSummary(
          base
        )}</div>`
      : "";
    // A machine with zero module slots (most burner machines in Pyanodon) can't
    // take modules at all - offering a picker there is a trap, not a feature.
    const noSlots = slots === 0;
    // Рецепту нужен свой модуль (хлопкоеды, породы, растения): без него машина не
    // «нерабочая», но считает по-другому — в игре скорость фермы это
    // (1 + бонусы модулей), а сам завод считается за один модуль
    // (pypostprocessing: py.farm_speed(slots, speed) = speed / (slots + 1)).
    // Поэтому без модулей этап медленнее ровно в (slots + 1) раз, и об этом надо
    // сказать прямо: человек мог удалить модуль случайно.
    const required = recipeDefaultModule(machine, recipe);
    let requiredWarn = "";
    if (required && !noSlots) {
      const installed = (node.modules || []).filter((m) => {
        const d = moduleDef(m.name);
        return d && d.typeId === required.typeId && Math.max(0, Math.floor(m.count || 0)) > 0;
      });
      if (!installed.length) {
        const slotsN = slots != null ? slots : 0;
        const fullMult = 1 + (required.effects.speed || 0) * slotsN;
        const nowMult = 1 + (fromModules.speed || 0);
        const times = fullMult / (nowMult > 0 ? nowMult : 1);
        requiredWarn = `<div class="stageModulesWarn">⚠ Нужного модуля «${required.label}» нет.${
          times > 1.05 && slotsN
            ? ` В игре такой этап работает, но примерно <b>в ${times.toFixed(1)} раз медленнее</b> — сам завод считается за один модуль, а полный набор это ${slotsN} ${
                pluralModules(slotsN)
              }. Числа ниже описывают именно эту, медленную фабрику.`
            : " Без него этот рецепт в игре не пойдёт так, как посчитано."
        }</div>`;
      }
    }
    return `
      <div class="stageModules">
        ${baseLine}
        <div class="stageModulesRow">
          <button class="addModuleBtn" data-node="${node.id}" ${noSlots ? "disabled" : ""} title="${
            noSlots
              ? "В этом заводе нет слотов под модули"
              : "Выбрать модуль по типу (скорость / продуктивность / эффективность / качество / модовые)"
          }">🔧 + модуль</button>
          ${noSlots ? `<span class="hint">слотов нет</span>` : ""}
          ${chips}
        </div>
        ${
          used
            ? `<div class="stageModulesInfo ${over ? "modOver" : ""}">
                 ${slots != null ? `слоты: ${used} / ${slots}${over ? " — превышено!" : ""}` : `модулей на завод: ${used}`}
                 · от модулей: ${moduleEffectsSummary(fromModules)}
               </div>`
            : ""
        }
        ${requiredWarn}
        ${
          over
            ? `<div class="stageModulesWarn">⚠ модулей ${used}, а слотов у завода ${slots}: лишние ${used - slots} в игре не встанут.
                 ${slots} модулей — максимум для этого завода.</div>`
            : ""
        }
      </div>`;
  }

  // The picker itself: grouped BY TYPE, never a flat list of names. Types come
  // from the dataset (so a mod's own module category shows up as its own group)
  // plus the four standard ones, which are always offered even if this dump
  // doesn't have them (quality modules in a pre-Space-Age dump).
  // target: "machine" (default) or "beacon" - a beacon has its own slots and its
  // own allowed effects (most beacons refuse productivity), so the same picker is
  // reused with a different host.
  function openModulePickerModal(nodeId, target) {
    const node = findTreeNodeById(state.cascade.root, nodeId);
    if (!node) return;
    ensureNodeEffects(node);
    const intoBeacon = isBeaconTarget(target);
    const recipe = state.dataset.recipes[node.recipeName];
    const machine = intoBeacon
      ? beaconOfRow(beaconRows(node)[parseBeaconTarget(target)])
      : (state.dataset.entities || {})[node.machineName];
    const slots = machineModuleSlots(machine);
    const groups = moduleCatalogByType();

    // Pyanodon has ~60 module categories (every TURD module and half its wildlife
    // is one). Two sections: what fits this machine, and everything else -
    // collapsed, but fully usable. Nothing is hidden and nothing is dead; see
    // moduleTypeFitness for why the old hard filter was a mistake.
    const entries = [...groups.entries()].map(([typeId, mods]) => ({
      typeId,
      mods,
      ...moduleTypeFitness(typeId, machine, recipe),
    }));
    const fitting = entries.filter((e) => e.suits);
    const others = entries.filter((e) => !e.suits);

    const optionHTML = (m) => {
      const fit = moduleFitsMachine(m, machine, recipe);
      return `<div class="modOption ${fit.ok ? "" : "modOptionRejected"}" data-module="${m.name}" ${
        fit.ok ? "" : `data-reject="${fit.reason}"`
      }>
        <div class="modOptionHead">${m.icon ? iconImg(m.icon, 20) : ""}<b>${m.label}</b>${
        m.virtual ? ` <span class="hint">(нет в датасете)</span>` : ""
      }${m.tier ? ` <span class="hint">МК${m.tier}</span>` : ""}</div>
        <div class="modOptionFx">${moduleEffectsSummary(m.effects)} <span class="modSrc">${
        m.source === "custom" ? "свои значения" : m.source === "dump" ? "из дампа" : m.source === "default" ? "по умолчанию" : "не заданы"
      }</span></div>
        ${fit.ok ? "" : `<div class="modOptionWhy">⚠ ${fit.reason} — в игре не встанет</div>`}
        <button class="modEditBtn" data-module="${m.name}" title="Задать свои бонусы для этого модуля (для модовых модулей, которых нет в дампе)">✎ бонусы</button>
        <div class="modEditor" data-module="${m.name}" hidden>
          ${MODULE_EFFECT_KEYS.map(
            (k) =>
              `<label>${MODULE_EFFECT_LABELS[k]} <input type="number" step="1" class="modFx" data-fx="${k}" data-module="${
                m.name
              }" value="${Math.round((m.effects[k] || 0) * 100)}" />%</label>`
          ).join("")}
          <button class="modSaveFxBtn" data-module="${m.name}">Сохранить</button>
        </div>
      </div>`;
    };

    const sectionHTML = (list) =>
      list
        .map(
          (e) => `<div class="modGroup">
            <div class="modGroupHead"><span class="modDot mod-${e.typeId}"></span>${moduleTypeById(e.typeId).label}${
            e.reason ? ` <span class="hint">— ${e.reason}</span>` : ""
          }</div>
            <div class="modGroupItems">${e.mods.map(optionHTML).join("")}</div>
          </div>`
        )
        .join("");

    const groupHTML = `${
      fitting.length ? sectionHTML(fitting) : `<p class="hint msg">Ничего не подобралось автоматически — смотри «остальные категории».</p>`
    }${
      others.length
        ? `<details class="modOthers" ${fitting.length ? "" : "open"}>
             <summary>Остальные категории (${others.length}) — в этот завод не встанут</summary>
             <p class="hint">${
               machineModuleCategories(machine).length
                 ? `Дамп прямо говорит, что завод принимает только ${machineModuleCatsText(machine)} — игра такие модули не пустит. Список показан, чтобы было видно, что именно отсекается.`
                 : `Дамп не сообщает категории этого завода, поэтому запрещать нечего — но и рекомендовать нечего.`
             }</p>
             ${sectionHTML(others)}
           </details>`
        : ""
    }`;

    const overlay = document.createElement("div");
    overlay.className = "modalOverlay";
    overlay.innerHTML = `<div class="modalPanel modalPanelWide">
        <div class="modalHeader">Модули ${intoBeacon ? "в маяк" : "для"} «${machineDisplayName(machine)}»${
      slots != null ? ` <span class="hint">(слотов: ${slots})</span>` : ""
    } <button class="modalClose">✕</button></div>
        <p class="hint">Выбор по типу модуля, а не по имени: работают и модули качества (Space Age), и модовые категории (TURD-модули Pyanodon и т.п.). Если бонусы модуля неизвестны — задай их кнопкой «✎ бонусы», они запомнятся для этого датасета.</p>
        <div class="modPickerTools">
          <input id="modSearch" class="input" placeholder="поиск по названию или категории…" autocomplete="off" />
          <span class="hint modEvidence" title="Что именно сказал дамп про этот завод. Если это расходится с игрой — покажи мне эту строку, поправим экспорт.">${moduleRulesEvidence(
            machine,
            recipe
          )}</span>
        </div>
        <div class="modalBody modPickerBody">${groupHTML}</div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector(".modalClose").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    // Live filter: with 60 categories, scrolling is not a search strategy.
    const search = overlay.querySelector("#modSearch");
    if (search) {
      search.addEventListener("input", () => {
        const q = search.value.toLowerCase().trim();
        // a hit inside the collapsed "остальные" section must not stay invisible
        const others = overlay.querySelector(".modOthers");
        if (others && q) others.open = true;
        overlay.querySelectorAll(".modGroup").forEach((group) => {
          let visible = 0;
          group.querySelectorAll(".modOption").forEach((opt) => {
            const hay = (opt.textContent + " " + (opt.dataset.module || "")).toLowerCase();
            const match = !q || hay.includes(q);
            opt.hidden = !match;
            if (match) visible++;
          });
          const headMatch = !q || group.querySelector(".modGroupHead").textContent.toLowerCase().includes(q);
          if (headMatch && !visible) group.querySelectorAll(".modOption").forEach((o) => (o.hidden = false));
          group.hidden = !visible && !headMatch;
        });
      });
      setTimeout(() => search.focus(), 0);
    }

    // "✎ бонусы" opens inline fields; saving them re-tunes that module for the
    // whole dataset (localStorage) and re-solves, since chains may use it.
    overlay.addEventListener("click", (e) => {
      const editBtn = e.target.closest(".modEditBtn");
      if (editBtn) {
        e.stopPropagation();
        const ed = overlay.querySelector(`.modEditor[data-module="${CSS.escape(editBtn.dataset.module)}"]`);
        if (ed) ed.hidden = !ed.hidden;
        return;
      }
      const saveBtn = e.target.closest(".modSaveFxBtn");
      if (saveBtn) {
        e.stopPropagation();
        const name = saveBtn.dataset.module;
        const fx = {};
        overlay.querySelectorAll(`.modFx[data-module="${CSS.escape(name)}"]`).forEach((inp) => {
          const v = parseFloat(inp.value);
          if (isFinite(v) && v !== 0) fx[inp.dataset.fx] = v / 100;
        });
        saveModuleOverride(name, fx);
        close();
        safeCall(recalcResults);
        return;
      }
      const option = e.target.closest(".modOption");
      if (!option || option.classList.contains("disabled")) return;
      const name = option.dataset.module;
      // Проверка, влезает ли модуль в этот завод (allowed_module_categories из дампа): не
      // влезающий не ставится, причина показывается.
      const fit = moduleFitsMachine(name, machine, recipe);
      if (!fit.ok) {
        safeCall(() => showErrorBanner(`${option.querySelector("b") ? option.querySelector("b").textContent : name}: ${fit.reason}`));
        return;
      }
      const list = moduleListFor(node, target);
      if (!list) return;
      const count = moduleCountToAdd(node, machine, name, target);
      if (count <= 0) {
        // Свободных слотов нет: сообщение с подсказкой (модуль с нулём слотов не сохранялся бы).
        const slots = machineModuleSlots(machine);
        safeCall(() => showErrorBanner(
          `Свободных слотов нет: ${intoBeacon ? "в этом маяке" : "в этом заводе"} уже занято ` +
          `${hostModuleCount(node, target)} из ${slots != null ? slots : "?"} — убери или уменьши другой модуль` +
          `${name ? ` (не добавлен: ${moduleDef(name) ? moduleDef(name).label : name})` : ""}`
        ));
        return;
      }
      const existing = list.find((m) => m.name === name);
      if (existing) existing.count = count;
      else list.push({ name, count });
      close();
      safeCall(recalcResults);
    });
  }

  function removeModuleFromNode(nodeId, moduleName, target) {
    const node = findTreeNodeById(state.cascade.root, nodeId);
    if (!node) return;
    if (isBeaconTarget(target)) {
      const row = beaconRows(node)[parseBeaconTarget(target)];
      if (row) row.modules = asArray(row.modules).filter((m) => m.name !== moduleName);
    } else {
      node.modules = (node.modules || []).filter((m) => m.name !== moduleName);
      // Человек убрал модуль ОСОЗНАННО — значит калькулятор не должен подставлять
      // его обратно на следующем пересчёте. Именно это и делает пометка
      // autoModulesFor (см. autoFillRecipeModules): без неё удалённый модуль
      // возвращался через полсекунды, и предупреждение «нужного модуля нет»
      // показать было невозможно.
      node.autoModulesFor = `${node.recipeName}@${node.machineName}`;
    }
    recomputeNodeEffects(node);
    return recalcResults();
  }

  function renderResults() {
    renderCalcTabBar();
    renderMakeFromPanel();
    renderNetOutputNote();
    const box = document.getElementById("resultsBody");
    const result = state.lastResult;
    const rateInput = document.getElementById("recalcTargetRate");
    const rateUnitSelect = document.getElementById("recalcTargetRateUnit");
    const unit = state.cascade.targetRateUnit || "sec";
    if (rateUnitSelect) rateUnitSelect.value = unit;
    if (rateInput && state.cascade.targetRate != null) {
      rateInput.value = unit === "min" ? +(state.cascade.targetRate * 60).toFixed(4) : state.cascade.targetRate;
    }

    const chainIcon = document.getElementById("chainIcon");
    const chainNameInput = document.getElementById("chainName");
    if (state.cascade.root && state.cascade.root.primaryProduct && state.dataset) {
      const finalKey = state.cascade.root.primaryProduct;
      chainIcon.innerHTML = iconImg(keyIconUrl(state.dataset, finalKey), 28);
      if (chainNameInput && !chainNameInput.value) {
        chainNameInput.value = keyDisplayName(state.dataset, finalKey);
      }
    } else if (chainIcon) {
      chainIcon.innerHTML = "";
    }

    if (!result) {
      box.innerHTML = `<p class="hint msg">Соберите цепочку и нажмите «Рассчитать».</p>`;
      renderBeaconsSection();
      return;
    }
    if (result.error || !result.nodes) {
      box.innerHTML = `<p class="error">${result.error || "Неожиданный ответ сервера."}</p>`;
      renderBeaconsSection();
      return;
    }

    const depths = computeNodeDepths(state.cascade.root);
    const maxDepth = Math.max(0, ...Array.from(depths.values()));

    let html = "";
    for (let depth = maxDepth; depth >= 0; depth--) {
      const nodesAtDepth = Object.values(result.nodes).filter((n) => depths.get(n.id) === depth);
      if (!nodesAtDepth.length) continue;
      const stageNum = maxDepth - depth + 1;
      html += `<div class="stageGroup"><div class="stageTitle">Этап ${stageNum}${depth === 0 ? " · конечный продукт" : ""}</div><div class="stageCards">`;
      for (const n of nodesAtDepth) {
        const recipe = state.dataset.recipes[n.recipeName];
        const treeNode = findTreeNodeById(state.cascade.root, n.id);
        const machine = (state.dataset.entities || {})[n.machineName];
        const fuels = compatibleFuels(state.dataset, machine);
        const burnsFluid = fuelKind(machine) === "fluid";
        const fuelSelectHtml = fuels.length
          ? `<select class="fuelSelectResult" data-node="${n.id}" title="${
              burnsFluid ? "Жидкое топливо (подаётся по трубе, считается в разделе жидкостей)" : "Топливо для завода"
            }">${fuels
              .map(
                (f) =>
                  `<option value="${f.name}" data-icon="${f.icon_url || ""}" ${treeNode && f.name === treeNode.fuelItem ? "selected" : ""}>${
                    burnsFluid ? "⛽ " : ""
                  }${f.display_name || prettify(f.name)}</option>`
              )
              .join("")}</select>`
          : "";
        let burntResultHtml = "";
        const ashInfo = stageAshInfo(n, treeNode, machine);
        const ashTogether = !!(treeNode && treeNode.ashWithOutput && ashInfo);
        if (treeNode && machine && fuels.length && treeNode.fuelItem && !burnsFluid) {
          const fuelItem = fuelEntry(state.dataset, machine, treeNode.fuelItem);
          const totalFuelRate =
            fuelConsumptionPerMachine(machine, fuelItem, effectsWithMachineBase(treeNode, machine).consumption) * n.machines;
          if (totalFuelRate > 1e-9) {
            // Fuel is a solid input like any other - it's planned together with
            // the ingredients inside renderStageFeedSection (marked «топливо»).
            // Burning it can leave a byproduct (coal -> ash in Pyanodon). По
            // умолчанию пепел едет своей лентой; переключатель у заголовка
            // «Выход» позволяет считать его вместе с основным выходом — тогда
            // отдельной строки тут нет, он показан в общем потоке.
            if (fuelItem && fuelItem.burnt_result && !ashTogether) {
              const ashStreams = stageInserterStreams(n, "ash");
              burntResultHtml =
                `<div class="beltSubLabel">Остаток от сгорания топлива:</div>` +
                renderItemsBeltCell({ [itemKey("item", fuelItem.burnt_result)]: totalFuelRate }, n.machines, "out", n.id) +
                `<div class="inserterRowWrap">${inserterPickerHTML(n.id, "ash", ashStreams, "пепел уезжает своей лентой")}</div>`;
            }
          }
        }
        // Effects on a stage come from two places now: the MODULES actually
        // slotted into the machine (picked by type - see the MODULES section),
        // and the hand-typed % fields, which are left for everything we don't
        // model (beacons above all). node.effects is the sum of both, and it's
        // what drives machine count (speed), output (productivity) and fuel
        // burn / ash (consumption).
        const treeNodeForEffects = findTreeNodeById(state.cascade.root, n.id);
        if (treeNodeForEffects) ensureNodeEffects(treeNodeForEffects);
        const eff = (treeNodeForEffects && treeNodeForEffects.effects) || {};
        const man = (treeNodeForEffects && treeNodeForEffects.manualEffects) || {};
        const allowsProd = recipe && recipe.allow_productivity;
        const modulesHtml = treeNodeForEffects ? modulesBlockHTML(treeNodeForEffects, machine, recipe, eff) : "";
        const effectsHtml = `
            <div class="stageEffectsLabel">Дополнительно вручную (маяки и т.п.):</div>
            <div class="stageEffects">
              <label title="Бонус скорости сверх модулей (маяки), %"><input type="number" class="effSpeed" data-node="${n.id}" step="10" value="${Math.round(
          (man.speed || 0) * 100
        )}" />% скор</label>
              <label title="${
                allowsProd ? "Бонус продуктивности сверх модулей, % (влияет только на выход)" : "Этот рецепт не принимает продуктивность"
              }"><input type="number" class="effProd" data-node="${n.id}" step="10" value="${Math.round((man.productivity || 0) * 100)}" ${
          allowsProd ? "" : "disabled"
        } />% прод</label>
              <label title="Доп. энергопотребление сверх модулей, % — у топливных заводов напрямую увеличивает расход топлива и пепла"><input type="number" class="effCons" data-node="${
                n.id
              }" step="10" value="${Math.round((man.consumption || 0) * 100)}" />% энерг</label>
            </div>`;
        // Кнопка «Приоритет» ставится только у той стороны, которая вообще есть:
        // у этапа без твёрдого входа (или выхода) согласовывать нечего.
        const hasSolidInputs = Object.keys(stageSolidInputs(n, treeNodeForEffects || state.cascade.root)).length > 0;
        const hasSolidOutputs = Object.entries(n.products || {}).some(([k, v]) => k.startsWith("item:") && v > 0);
        html += `
          <div class="stageCard">
            <div class="stageCardHead">${iconImg(recipeIconUrl(recipe), 30)}<span class="name">${recipeDisplayName(recipe)}</span></div>
            <select class="machineSelectResult" data-node="${n.id}">${machineSelectHTML(state.dataset, recipe, n.machineName)}</select>
            ${machineCraftNoteHTML(n.id, n.recipeName, n.machineName)}
            ${fuelSelectHtml}
            ${modulesHtml}
            ${effectsHtml}
            <div class="stageCardStats">
              <span>циклов/с: <b>${n.craftsPerSecond.toFixed(3)}</b></span>
              <span>заводов: <input type="number" min="1" step="1" class="machinesInput" data-node="${n.id}" value="${n.machinesCeil}" style="width:72px;" /> <span class="hint">(${n.machines.toFixed(2)})</span>
                <button type="button" class="btn btn-ghost recalcNodeBtn" data-node="${n.id}" title="Пересчитать цепочку, масштабируя так, чтобы заданное число заводов стало текущим">Пересчитать</button>
                <button type="button" class="btn btn-ghost blueprintBtn" data-node="${n.id}" title="Собрать блюпринт блока: заводы в ряд, ленты подачи снаружи, лента выгрузки между столбцами. Куда едет выгрузка — настройка «Лента выхода» в панели чертежа (в одну сторону с подачей или в другую). Трубы не ставятся — тайлы под газ и жидкость остаются свободными.">Блюпринт</button>
              </span>
            </div>
            <div class="beltSubLabel">Вход (что подвозить):</div>
            ${renderStageFeedSection(n)}
            ${renderFluidLines(stageFluidInputs(n), true)}
            <div class="beltSubLabel">Выход (что вывозить): ${ashInfo ? ashToggleButtonHTML(n.id, ashTogether) : ""}</div>
            ${renderOutputPriorityBoxHTML(n, hasSolidInputs ? stageAlignPriority(n.id) : null)}
            ${renderBeltCell(n)}
            ${renderFluidLines(n.products, true)}
            ${burntResultHtml}
            ${renderCirculating(n)}
            <div class="bpPanelWrap" id="bpPanel-${n.id}"></div>
          </div>`;
      }
      html += `</div></div>`;
    }

    // Блока «Сырьё / профицит» нет: те же ресурсы показаны в панели «Входящие ресурсы».

    box.innerHTML = html;
    renderBeaconsSection();
  }

  // ---------- recalc in place (no navigation back to the builder) ----------

  function findTreeNodeById(node, id) {
    if (!node) return null;
    if (node.id === id) return node;
    for (const child of Object.values(node.children || {})) {
      const found = findTreeNodeById(child, id);
      if (found) return found;
    }
    return null;
  }

  function collectResultEdits() {
    function walk(node) {
      const sel = document.querySelector(`.machineSelectResult[data-node="${node.id}"]`);
      if (sel) node.machineName = sel.value;
      const fSel = document.querySelector(`.fuelSelectResult[data-node="${node.id}"]`);
      if (fSel) node.fuelItem = fSel.value;
      else clearFuelIfMachineBurnsNone(node); // switched to a machine with no fuel select
      // Modules/beacons. Only overwrite from a field that's actually on screen -
      // a missing field means "leave whatever the node already had".
      const pct = (cls) => {
        const el = document.querySelector(`.${cls}[data-node="${node.id}"]`);
        if (!el || el.value === "") return null;
        const v = parseFloat(el.value);
        return isFinite(v) ? v / 100 : null;
      };
      const speed = pct("effSpeed");
      const prod = pct("effProd");
      const cons = pct("effCons");
      ensureNodeEffects(node); // also migrates pre-modules chains
      if (speed !== null) node.manualEffects.speed = speed;
      if (prod !== null) node.manualEffects.productivity = prod;
      if (cons !== null) node.manualEffects.consumption = cons;
      // Module counts: pick up whatever is currently typed in the qty fields,
      // even if the user never pressed Enter (they may have just clicked a
      // machine dropdown instead - losing their number there would be rude).
      const readCounts = (list, target) => {
        for (const inst of list) {
          const el = document.querySelector(
            `.modQty[data-node="${node.id}"][data-module="${CSS.escape(inst.name)}"][data-target="${target}"]`
          );
          if (!el || el.value === "") continue;
          const v = parseInt(el.value, 10);
          if (isFinite(v)) inst.count = Math.max(0, v);
        }
        return list.filter((m) => m.count > 0);
      };
      node.modules = readCounts(node.modules || [], "machine");

      // Маяки: строки этого этапа живут прямо в разметке раздела «Маяки»,
      // поэтому забираем оттуда всё, что человек успел поменять и не подтвердил.
      const rows = beaconRows(node);
      rows.forEach((row, index) => {
        const sel = document.querySelector(`.beaconSelect[data-node="${node.id}"][data-row="${index}"]`);
        if (sel && sel.value) row.name = sel.value;
        const covers = document.querySelector(`.beaconCovers[data-node="${node.id}"][data-row="${index}"]`);
        if (covers) row.covers = parseCoversInput(covers.value);
        row.modules = readCounts(row.modules || [], beaconTarget(index));
      });
      recomputeNodeEffects(node); // effects = manual + modules, always derived
      for (const child of Object.values(node.children || {})) walk(child);
    }
    if (state.cascade.root) walk(state.cascade.root);
  }

  // If the node's current machine burns no fuel (e.g. an electric assembler),
  // drop any fuel item left over from a previous burner machine so it stops
  // being counted anywhere - belts, raw inputs, ash, everything.
  function clearFuelIfMachineBurnsNone(node) {
    ensureNodeFuel(node);
  }

  /** Топливо этапа согласовано с его заводом: у заводов без горения его нет, у
   *  горящих — выбранное подходит, а если нет (завод только что сменили, цепочка
   *  старая), берём первое подходящее. Так подача топлива и вывоз золы попадают
   *  в расчёт сразу, без захода в список топлива. */
  function ensureNodeFuel(node) {
    if (!node || !state.dataset) return node;
    const machine = (state.dataset.entities || {})[node.machineName];
    const fuels = compatibleFuels(state.dataset, machine);
    if (!fuels.length) node.fuelItem = null;
    else if (!fuels.some((f) => f.name === node.fuelItem)) node.fuelItem = fuels[0].name;
    return node;
  }

  /** Подпись эффекта маяков по всей цепочке: изменилась — расчёт надо повторить.
   *
   *  Считается по заводам последнего расчёта, поэтому сравнивать её до и после
   *  расчёта и значит «эффект, который ушёл на сервер, и эффект по новым заводам».
   */
  function beaconEffectsSignature() {
    const parts = [];
    if (!state.cascade.root) return "";
    walkTree(state.cascade.root, (node) => {
      const rows = node && Array.isArray(node.beacons) ? node.beacons : [];
      if (!rows.some((row) => row && row.name)) return;
      parts.push(`${node.id}:${JSON.stringify(beaconEffects(node))}`);
    });
    return parts.join("|");
  }

  async function recalcResults() {
    if (!state.cascade.root) return;
    collectResultEdits();
    const rateInput = document.getElementById("recalcTargetRate");
    const unit = state.cascade.targetRateUnit || "sec";
    // Did the person actually CHANGE the target rate, or is that just the value
    // renderResults parked in the field? On a grouped tab it decides whether the
    // edit drives the whole group (see below).
    const rateBefore = state.cascade.targetRate || 0;
    let rateEdited = false;
    if (rateInput && rateInput.value) {
      const displayed = parseFloat(rateInput.value);
      if (isFinite(displayed)) {
        const entered = unit === "min" ? displayed / 60 : displayed;
        rateEdited = Math.abs(entered - rateBefore) > 1e-9 * Math.max(1, Math.abs(rateBefore));
        state.cascade.targetRate = entered;
      }
    }
    await recalcChainAndTabs(rateEdited);
  }

  /** Пересчитать ВСЮ цепочку и ВСЕ вкладки этого рецепта.
   *
   *  Общий хвост для «Пересчитать», «Полная лента …» и правок раскладки: масштаб
   *  меняет потребности, значит должны пересчитаться и этапы цепочки, и дочерние
   *  вкладки (те, что человек отпочковал от сырья), и группы вкладок.
   */
  async function recalcChainAndTabs(rateEdited) {
    await runSolve();
    // Маяки: эффект маяка зависит от числа заводов этапа (маяк накрывает свою
    // часть этапа, и в расчёт уходит среднее по этапу), а число заводов зависит
    // от эффекта. Один расчёт берёт заводы от ПРЕДЫДУЩЕГО раза, поэтому правка
    // «покрывает заводов» показала бы числа, посчитанные не по тем заводам.
    // Досчитываем, пока эффект не перестанет меняться (обычно хватает второго
    // расчёта; в цепочке без маяков лишних запросов нет вовсе).
    let beaconSignature = beaconEffectsSignature();
    for (let pass = 0; pass < 3 && beaconSignature; pass += 1) {
      const now = beaconEffectsSignature();
      if (now === beaconSignature) break;
      beaconSignature = now;
      await runSolve();
    }
    state.inputPairs = {}; // machines/rate may have changed - let pairing be re-suggested
    saveCurrentTabSnapshot();
    // Осиротевшие ссылки вкладок на родителя починить ДО обхода: иначе дочерняя
    // вкладка с мёртвой ссылкой молча остаётся со старой целью (её «Пересчитать»
    // не трогал). См. repairTabParentLinks.
    repairTabParentLinks(calcTabs[activeTabIndex] && calcTabs[activeTabIndex].id);
    // If this active tab is part of a group, redistribute that group so
    // other member tabs are recalculated to follow the new numbers.
    try {
      const activeTab = calcTabs[activeTabIndex];
      if (activeTab && activeTab.groupId && tabGroups[activeTab.groupId]) {
        const group = tabGroups[activeTab.groupId];
        // An edited rate means "the group should make this much" - the same rule
        // the «Пересчитать» button next to «заводов» already uses. Redistributing
        // to the OLD total instead silently threw the edit away, which is why a
        // change made on the head tab looked like the group recalculating wrong.
        const target = rateEdited
          ? state.cascade.targetRate
          : group.targetTotal || computeGroupTotal(activeTab.groupId);
        await redistributeGroup(activeTab.groupId, target);
      }
    } catch (e) {
      // ignore group redistribution failures - still continue with descendants
    }
    await recalcDescendantTabs(calcTabs[activeTabIndex].id);
    // A chain that eats its own product is scaled up until the NET output
    // matches the requested number (see settleNetTarget / the «чистый выход» note).
    await settleChainNet(calcTabs[activeTabIndex].id);
    renderResults();
    renderInputResources();
  }

  // If this recalculation changed how much of some resource is needed, any
  // tab that was spun off from that resource (via the input-resource picker)
  // needs its target rate updated to match, and re-solved - recursively, in
  // case that tab in turn has its own child tabs.
  //
  // Children that belong to a GROUP are handled as one unit, not one by one:
  // the members TOGETHER have to cover the parent's need, so handing the whole
  // need to each of them made the group produce it N times over. That is the
  // "медная плита -> медь 4 сорта двумя рецептами" case: after «Пересчитать» on
  // the parent both members were sized for the full demand instead of splitting
  // it, while grouping them by hand looked right (groupTabs -> redistributeGroup).
  /** Сколько этого ресурса вкладка тянет снаружи (сырьё + топливо) — или null.
   *
   *  Для активной вкладки берём состояние (оно только что пересчитано), для
   *  остальных — их слепок. Результат с ошибкой не годится: по нему потребность
   *  неизвестна, а выдумывать её нельзя.
   */
  function tabNeedForItem(tabId, itemKey) {
    const activeId = calcTabs[activeTabIndex] && calcTabs[activeTabIndex].id;
    const snap = tabId === activeId ? null : tabSnapshots[tabId];
    const cascade = tabId === activeId ? state.cascade : snap && snap.cascade;
    const result = tabId === activeId ? state.lastResult : snap && snap.lastResult;
    if (!cascade || !result || result.error) return null;
    let need = null;
    try {
      need = tabRawNeed(cascade, result, itemKey);
    } catch (e) {
      return null;
    }
    return need != null && need > 0 ? need : null;
  }

  /** Починить «осиротевшие» ссылки вкладок на родителя — по ресурсу.
   *
   *  Вкладка, выращенная из ресурса («+ вкладка» у сырья), помнит родителя по id
   *  (parentInfo.tabId). Если родительскую вкладку закрыли или цепочку пересобрали, id
   *  мёртвый, и «Пересчитать» пропускал такую вкладку.
   *
   *  Родитель ищется заново по ресурсу: подходит вкладка, чья цепочка действительно просит
   *  этот ресурс (сырьё или топливо). Активная вкладка важнее прочих; если подходит не она
   *  и кандидатов несколько, ссылка не меняется. Сама вкладка и её потомки не выбираются
   *  (иначе получилось бы кольцо).
   */
  function repairTabParentLinks(activeTabId) {
    const known = new Set(calcTabs.map((t) => t.id));
    let repaired = 0;
    for (const tab of calcTabs) {
      const info = tab.parentInfo;
      if (!info || !info.itemKey || !info.tabId) continue;
      if (known.has(info.tabId)) continue;   // ссылка живая, трогать нечего
      const banned = new Set(chainTabIds(tab.id));   // сама вкладка и её потомки
      const candidates = calcTabs
        .filter((t) => !banned.has(t.id) && tabNeedForItem(t.id, info.itemKey) != null)
        .map((t) => t.id);
      if (!candidates.length) continue;
      const pick = candidates.includes(activeTabId)
        ? activeTabId
        : candidates.length === 1
        ? candidates[0]
        : null;
      if (!pick) continue;
      info.tabId = pick;   // остальные поля ссылки (ресурс и возможные новые) не трогаем
      repaired += 1;
    }
    return repaired;
  }

  async function recalcDescendantTabs(parentTabId) {
    const children = calcTabs.filter((t) => t.parentInfo && t.parentInfo.tabId === parentTabId);
    if (!children.length) return;
    const parentSnap = tabSnapshots[parentTabId];
    const parentResult = parentSnap && parentSnap.lastResult;
    const parentCascade = parentSnap && parentSnap.cascade;
    const working = { cascade: state.cascade, lastResult: state.lastResult, inputPairs: state.inputPairs };

    const soloChildren = [];
    const groupNeeds = new Map(); // groupId -> need of the parents feeding it
    const countedNeeds = new Set();
    for (const child of children) {
      const itemKey = child.parentInfo.itemKey;
      if (child.groupId && tabGroups[child.groupId]) {
        const pid = child.parentInfo.tabId;
        const pidSnap = pid === parentTabId ? parentSnap : tabSnapshots[pid];
        const pidResult = pidSnap && pidSnap.lastResult;
        const pidCascade = pidSnap && pidSnap.cascade;
        const need = tabRawNeed(pidCascade, pidResult, itemKey);
        // Several members of one group usually come from the SAME parent for the
        // same resource: that is still ONE need, so count it once.
        const dedupKey = `${child.groupId}|${pid}|${itemKey}`;
        if (need != null && need > 0 && !countedNeeds.has(dedupKey)) {
          countedNeeds.add(dedupKey);
          groupNeeds.set(child.groupId, (groupNeeds.get(child.groupId) || 0) + need);
        }
        continue;
      }
      const newRate = tabRawNeed(parentCascade, parentResult, itemKey);
      soloChildren.push({ child, newRate });
    }

    try {
      for (const { child, newRate } of soloChildren) {
        const snap = tabSnapshots[child.id];
        if (!snap || !snap.cascade) continue;
        if (newRate != null && newRate > 0) snap.cascade.targetRate = newRate;
        state.cascade = snap.cascade;
        state.lastResult = snap.lastResult;
        state.inputPairs = snap.inputPairs || {};
        await runSolve();
        state.inputPairs = {};
        tabSnapshots[child.id] = { cascade: state.cascade, lastResult: state.lastResult, inputPairs: state.inputPairs };
        await recalcDescendantTabs(child.id);
      }
      // redistributeGroup reads `state` as "the tab the person is looking at", so
      // put the active tab's data back before driving it (the loop above left the
      // state pointing at the last child it solved).
      state.cascade = working.cascade;
      state.lastResult = working.lastResult;
      state.inputPairs = working.inputPairs;
      for (const [groupId, need] of groupNeeds) {
        await redistributeGroup(groupId, need);
      }
    } finally {
      state.cascade = working.cascade;
      state.lastResult = working.lastResult;
      state.inputPairs = working.inputPairs;
    }
  }

  // ---------- input resources: draggable, pairable onto shared belts ----------

  // ---------- smart multi-belt packing for input resources ----------
  // A resource's demand splits into whole full belts plus at most one leftover
  // chunk. If the leftover is more than half a belt it needs its own (partly
  // filled) belt; if it's half a belt or less it can share the free side of a
  // belt with some OTHER resource's leftover. This is pure throughput - we
  // deliver the required rate, we don't round up to whole machines here.
  function computeSmartBeltPlan(items) {
    const laneSpeed = state.belt.speed / 2;
    const fullBeltCapacity = laneSpeed * 2;
    const perResource = {};
    const leftovers = [];

    for (const [key, rate] of items) {
      const neededPerMachine = getNeededPerMachine(key);
      const impossible = neededPerMachine > fullBeltCapacity + 1e-9; // one machine can't be fed by a single belt
      const fullBelts = Math.floor(rate / fullBeltCapacity + 1e-9);
      let leftoverRate = rate - fullBelts * fullBeltCapacity;
      let partialOwnBelt = false;
      if (leftoverRate > laneSpeed + 1e-9) {
        // more than half a belt - can't share a side, needs its own partial belt
        partialOwnBelt = true;
      }
      perResource[key] = { rate, fullBelts, leftoverRate, partialOwnBelt, neededPerMachine, impossible };
      if (leftoverRate > 1e-9 && !partialOwnBelt) leftovers.push({ key, rate: leftoverRate });
    }

    // pair shareable leftovers largest-with-smallest so belts fill up nicely
    leftovers.sort((a, b) => b.rate - a.rate);
    const sharedBelts = [];
    let i = 0,
      j = leftovers.length - 1;
    while (i < j) {
      sharedBelts.push([leftovers[i], leftovers[j]]);
      i++;
      j--;
    }
    if (i === j) sharedBelts.push([leftovers[i], null]);

    const sharedByKey = {};
    sharedBelts.forEach(([a, b]) => {
      if (a) sharedByKey[a.key] = { partner: b, mine: a };
      if (b) sharedByKey[b.key] = { partner: a, mine: b };
    });

    return { perResource, sharedByKey, laneSpeed, fullBeltCapacity };
  }

  function renderSmartResourceLine(key, plan, coveredBy) {
    const info = plan.perResource[key];
    const name = keyDisplayName(state.dataset, key);
    const icon = iconImg(keyIconUrl(state.dataset, key), 16);
    const parts = [];
    if (info.fullBelts > 0) {
      parts.push(info.fullBelts === 1 ? `1 полная лента` : `${info.fullBelts} ${pluralBelts(info.fullBelts)} целиком`);
    }
    const lead = parts.length ? "ещё " : ""; // "ещё" only makes sense after a full belt
    if (info.partialOwnBelt) {
      const pct = (info.leftoverRate / plan.fullBeltCapacity) * 100;
      parts.push(`${lead}1 лента отдельно ${beltFillBarHTML(pct)} <span class="hint">(больше половины — не делится)</span>`);
    }
    const shared = plan.sharedByKey[key];
    if (shared) {
      const myPct = (shared.mine.rate / plan.laneSpeed) * 100;
      if (shared.partner) {
        const partnerName = keyDisplayName(state.dataset, shared.partner.key);
        const partnerPct = (shared.partner.rate / plan.laneSpeed) * 100;
        // «моя сторона / их сторона» ни о чём не говорило: непонятно, чья это
        // сторона и что она значит. Пишем прямо: лента на двоих, у каждого своя
        // половина, и на сколько она заполнена.
        parts.push(
          `${lead}1 лента на двоих с «${partnerName}»: половина ленты под «${name}» — ${beltFillBarHTML(myPct)}, ` +
          `половина под «${partnerName}» — ${beltFillBarHTML(partnerPct)}`
        );
      } else {
        parts.push(`${lead}1 лента, занята только одна половина ${beltFillBarHTML(myPct)}`);
      }
    }
    if (!parts.length) parts.push("не требуется лента");
    // «Полная лента этого ресурса»: масштабируем цепочку так, чтобы ресурс встал
    // на ЦЕЛУЮ ленту СВОЕЙ лентой (остаток получает полную ленту, а не половинку
    // на пару с соседом). Кнопка есть и когда ресурс сейчас с соседом: нажатие
    // снимает эту пару. Кнопка «Полная лента для группы» в заголовке блока
    // остаётся — она про текущую общую ленту (дотянуть сторону до целой).
    const paired = !!(shared && shared.partner);
    const laneFull = paired ? (shared.mine.rate / plan.laneSpeed) * 100 >= 99.5 : false;
    const wholeFull = info.fullBelts > 0 && info.leftoverRate <= 1e-9;
    const alreadyFull = paired ? false : wholeFull;
    void laneFull;
    const btn = alreadyFull ? "" : ` ${fullBeltResourceButtonHTML(key)}`;
    const cover = inputResCover(key, coveredBy);
    let line = `<div class="inputResLine${cover.cls}">${icon}<b>${name}</b>: нужно ${info.rate.toFixed(2)}/сек → ${parts.join(" + ")}${btn}${cover.note}</div>`;
    if (info.impossible) {
      line += `<div class="inputResWarn">⚠ этому ресурсу нужно ≥ ${info.neededPerMachine.toFixed(2)}/сек на один завод — это больше, чем несёт целая лента (${plan.fullBeltCapacity}/сек), одной лентой завод не прокормить.</div>`;
    }
    return line;
  }

  function getNeededPerMachine(key) {
    let neededPerMachine = 0;
    if (state.lastResult) {
      for (const n of Object.values(state.lastResult.nodes)) {
        const consumeRate = (n.ingredients || {})[key];
        if (consumeRate && n.machines > 0) {
          neededPerMachine = Math.max(neededPerMachine, consumeRate / n.machines);
        }
      }
    }
    return neededPerMachine;
  }

  // Manual override model (used once the person has dragged something
  // themselves) - simple whole-resource pairing via state.inputPairs.
  function computeInputBeltInfo(key, ratePerSec) {
    const pairedWith = state.inputPairs[key];
    // Unpaired: the resource gets its own belt filling BOTH sides (machines in
    // two columns) = full belt. Paired: it shares a belt with another resource,
    // one per side, so it's capped at one side.
    const perBeltCapacity = pairedWith ? state.belt.speed / 2 : state.belt.speed;
    const beltsNeededExact = ratePerSec / perBeltCapacity;
    const beltsNeeded = Math.max(1, Math.ceil(beltsNeededExact - 1e-9));
    const lastBeltRate = ratePerSec - (beltsNeeded - 1) * perBeltCapacity;
    const fillPct = Math.min(100, (lastBeltRate * 100) / perBeltCapacity);
    const neededPerMachine = getNeededPerMachine(key);
    const starves = pairedWith && perBeltCapacity < neededPerMachine;
    return { pairedWith, perBeltCapacity, beltsNeeded, lastBeltRate, fillPct, starves, neededPerMachine };
  }

  // `cascade`/`result` default to the ACTIVE tab, but a parent tab being walked
  // during recalcDescendantTabs is not the active one - it has to be passed in.
  function computeFuelInputs(cascade, result) {
    const fuelTotals = {};
    const cas = cascade || state.cascade;
    const res = result || state.lastResult;
    if (!res || !cas || !cas.root) return fuelTotals;
    for (const n of Object.values(res.nodes)) {
      const treeNode = findTreeNodeById(cas.root, n.id);
      const machine = (state.dataset.entities || {})[n.machineName];
      if (!treeNode || !machine || !treeNode.fuelItem) continue;
      if (!compatibleFuels(state.dataset, machine).length) continue; // machine burns no fuel
      const fuel = fuelEntry(state.dataset, machine, treeNode.fuelItem);
      const rate =
        fuelConsumptionPerMachine(machine, fuel, effectsWithMachineBase(treeNode, machine).consumption) * n.machines;
      if (rate > 1e-9) {
        // item:coal for a burner, fluid:natural-gas for a gas-fired machine - the
        // input panel splits solids (belts) from fluids (pipes) by this prefix.
        const key = fuelKey(machine, treeNode.fuelItem);
        fuelTotals[key] = (fuelTotals[key] || 0) + rate;
      }
    }
    return fuelTotals;
  }

  // Shared by both the solid (belt) and fluid/gas (pipe) rows - builds the
  // clickable/draggable icon button used to open "how do I make this raw
  // resource" or pair it with another belt-mate. Pairing only makes sense
  // for solids (you can't split a pipe's contents across two lanes the way
  // a belt works), so `pairable` gates that part off for fluids/gases.
  function makeInputResBtn(key, amount, pairable, covered) {
    const btn = document.createElement("div");
    // Ресурс, который уже делают свои вкладки, остаётся на месте и работает как
    // обычно (клик — новая вкладка, перетаскивание — объединение лент), только
    // обведён зелёным: видно, что снаружи его, скорее всего, везти не надо.
    btn.className = "inputResBtn clickableForChain" + (covered ? " coveredByChain" : "");
    btn.draggable = pairable;
    btn.dataset.key = key;
    btn.title = covered
      ? "Этот ресурс уже делают другие открытые вкладки. Кликни, чтобы добавить ещё рецепт на новой вкладке, или перетащи на другой ресурс, чтобы объединить их на одной ленте"
      : "Кликни, чтобы построить отдельную цепочку получения этого ресурса на новой вкладке";
    const pairedWith = pairable ? state.inputPairs[key] : null;
    btn.innerHTML = `${iconImg(keyIconUrl(state.dataset, key), 32)}<span>${keyDisplayName(state.dataset, key)}</span>${
      pairedWith ? `<span class="pairTag">+ ${keyDisplayName(state.dataset, pairedWith)} ✕</span>` : `<span class="toChainHint">+ вкладка</span>`
    }`;
    btn.addEventListener("click", () => safeCall(() => openRecipePickerModal(key, amount)));
    if (pairable) {
      btn.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", key));
      btn.addEventListener("dragover", (e) => {
        e.preventDefault();
        btn.classList.add("dragOver");
      });
      btn.addEventListener("dragleave", () => btn.classList.remove("dragOver"));
      btn.addEventListener("drop", (e) => {
        e.preventDefault();
        btn.classList.remove("dragOver");
        const draggedKey = e.dataTransfer.getData("text/plain");
        if (!draggedKey || draggedKey === key) return;
        safeCall(() => {
          // clear any previous pairings for both sides, then pair them together
          const oldA = state.inputPairs[draggedKey];
          const oldB = state.inputPairs[key];
          if (oldA) delete state.inputPairs[oldA];
          if (oldB) delete state.inputPairs[oldB];
          state.inputPairs[draggedKey] = key;
          state.inputPairs[key] = draggedKey;
          renderInputResources();
        });
      });
      if (pairedWith) {
        btn.querySelector(".pairTag").addEventListener("click", (e) => {
          e.stopPropagation();
          safeCall(() => {
            delete state.inputPairs[key];
            delete state.inputPairs[pairedWith];
            renderInputResources();
          });
        });
      }
    }
    return btn;
  }

  function renderInputResources() {
    const row = document.getElementById("inputResourceRow");
    const out = document.getElementById("inputResourceResults");
    row.innerHTML = "";
    out.innerHTML = "";
    const result = state.lastResult;
    if (!result || result.error) return;
    const fuelTotals = computeFuelInputs();
    const merged = new Map(Object.entries(result.rawInputs || {}));
    for (const [key, rate] of Object.entries(fuelTotals)) {
      merged.set(key, (merged.get(key) || 0) + rate);
    }
    // Ресурс, который уже делают другие открытые вкладки (или сам контур), из
    // списка НЕ убираем: по нему нужно уметь добавить ещё рецепт и объединить с
    // другим. Просто обводим его зелёным и пишем, кто его делает, — чтобы человек
    // видел: снаружи везти, скорее всего, не надо.
    const coveredBy = new Map();
    for (const [key] of merged.entries()) {
      let cov = null;
      try {
        cov = flowCoverageFor(key);
      } catch (e) {
        cov = null;
      }
      if (cov && cov.share > 0) coveredBy.set(key, cov);
    }
    // Raw inputs here are always whatever the leaf recipe in the tree
    // directly consumes and has no child node building it - never "the
    // very first" resource further up the chain. That includes fluids and
    // gases (e.g. molten metal), which just don't travel by belt so they
    // get their own section below instead of the belt-packing math.
    const items = Array.from(merged.entries()).filter(([key, amount]) => key.startsWith("item:") && amount > 0);
    const fluids = Array.from(merged.entries()).filter(([key, amount]) => key.startsWith("fluid:") && amount > 0);
    if (!items.length && !fluids.length) {
      row.innerHTML = "";
      out.innerHTML = `<p class="hint msg">Нет внешнего сырья.</p>`;
      return;
    }

    // Manual mode kicks in only once the person has dragged something
    // themselves; otherwise we always show the automatic smart packing
    // (whole belts dedicated + leftovers combined with another resource).
    const manualMode = Object.keys(state.inputPairs).length > 0;

    for (const [key, amount] of items) {
      row.appendChild(makeInputResBtn(key, amount, true, coveredBy.has(key)));
    }
    for (const [key, amount] of fluids) {
      row.appendChild(makeInputResBtn(key, amount, false, coveredBy.has(key)));
    }

    let lines = [];
    if (items.length) {
      const amountByKey = new Map(items);
      const orderedKeys = items.map(([key]) => key);
      if (manualMode) {
        const renderManualLine = (key) => {
          const amount = amountByKey.get(key);
          const info = computeInputBeltInfo(key, amount);
          const name = keyDisplayName(state.dataset, key);
          const icon = iconImg(keyIconUrl(state.dataset, key), 16);
          const shareText = info.pairedWith ? ` (лента общая с ${keyDisplayName(state.dataset, info.pairedWith)})` : "";
          const fillDisplay = info.pairedWith
            ? `${beltFillBarHTML(info.fillPct)} <span class="hint">(своя половина ленты)</span>`
            : `${beltFillBarHTML(info.fillPct)} <span class="hint">(занимает всю ленту)</span>`;
          const fullBtn =
            !info.starves && info.fillPct < 99.5 ? ` ${fullBeltResourceButtonHTML(key)}` : "";
          const cover = inputResCover(key, coveredBy);
          let line = `<div class="inputResLine${cover.cls}">${icon}<b>${name}</b>: нужно ${amount.toFixed(2)}/сек${shareText} → ${info.beltsNeeded} ${pluralBelts(info.beltsNeeded)}: ${fillDisplay}${fullBtn}`;
          if (info.starves) {
            line += `<br/><span class="inputResWarn">⚠ половины ленты не хватит даже на один завод без простоя (нужно ≥ ${info.neededPerMachine.toFixed(2)}/сек на завод, а половина ленты даёт максимум ${info.perBeltCapacity}/сек — этому ресурсу нужна отдельная лента целиком)</span>`;
          }
          line += `${cover.note}</div>`;
          return line;
        };
        // In manual mode the pairing lives in state.inputPairs.
        const partnerOf = (key) => {
          const p = state.inputPairs[key];
          return p && amountByKey.has(p) ? p : null;
        };
        lines = buildInputResLines(orderedKeys, partnerOf, renderManualLine);
      } else {
        const plan = computeSmartBeltPlan(items);
        // Two resources share a belt when the smart plan pairs their leftovers.
        const partnerOf = (key) => {
          const s = plan.sharedByKey[key];
          return s && s.partner ? s.partner.key : null;
        };
        lines = buildInputResLines(orderedKeys, partnerOf, (key) => renderSmartResourceLine(key, plan, coveredBy));
      }
    }

    if (fluids.length) {
      const fluidLines = fluids.map(([key, amount]) => {
        const name = keyDisplayName(state.dataset, key);
        const icon = iconImg(keyIconUrl(state.dataset, key), 16);
        const cover = inputResCover(key, coveredBy);
        return `<div class="inputResLine${cover.cls}">${icon}<b>${name}</b>: нужно ${fluidRateEditorHTML(
          key,
          amount
        )} <span class="hint">(по трубе, лента не нужна)</span>${cover.note}</div>`;
      });
      lines.push(`<div class="inputResSectionLabel">Жидкости / газы</div>`);
      lines = lines.concat(fluidLines);
    }
    out.innerHTML = lines.join("");
  }

  /** Зелёная пометка «этот ресурс уже делают свои вкладки / контур».
   *
   *  Ресурс при этом ОСТАЁТСЯ в списке: по нему нужно уметь добавить ещё рецепт
   *  и объединить с другим (кнопка и перетаскивание работают как обычно). */
  function inputResCover(key, coveredBy) {
    const cov = coveredBy && coveredBy.get(key);
    if (!cov) return { cls: "", note: "" };
    const who = cov.group ? flowWhoList(cov.group.producers, 2) : "";
    const loopNote = cov.loop ? ` (контур №${flowLoopNumber(cov.model, cov.loop)})` : "";
    return {
      cls: " coveredByChain",
      note: `<div class="inputResCoverNote">🔁 уже делают свои вкладки${who ? `: ${who}` : ""}${loopNote} — снаружи везти, скорее всего, не нужно</div>`,
    };
  }

  function flowLoopNumber(model, loop) {
    if (!model || !loop) return "?";
    const idx = (model.loops || []).findIndex((l) => l.id === loop.id);
    return idx >= 0 ? idx + 1 : "?";
  }

  // ---------- solving (now delegated to the FastAPI backend) ----------

  async function runSolve() {
    if (!state.dataset) return false;
    const calcBtn = document.getElementById("calcBtn");
    const recalcBtn = document.getElementById("recalcBtn");
    [calcBtn, recalcBtn].forEach((b) => b && (b.disabled = true));
    try {
      if (!state.cascade.root) throw new Error("Сначала выберите корневой рецепт (вкладка «Поиск рецепта»).");
      // node.effects is DERIVED (manual bonuses + installed modules) - refresh it
      // for every node right before the solve, so a chain loaded from a link, a
      // saved chain from before modules existed, or a module retuned in the
      // picker all reach the solver with the correct numbers.
      ensureAllNodeEffects(state.cascade.root);
      const payload = {
        datasetId: state.datasetId,
        mode: "cascade",
        root: state.cascade.root,
        // grossTargetRate is set when the chain recycles its own product: then
        // targetRate is the NET output the person asked for, and the solver has
        // to be given the bigger number. See settleNetTarget.
        targetRate: state.cascade.grossTargetRate > 0 ? state.cascade.grossTargetRate : state.cascade.targetRate,
      };
      const response = await apiFetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const res = await response.json().catch(() => null);
      if (!response.ok) {
        // FastAPI's own validation errors come back as {"detail": "..."},
        // which is a different shape from the solver's {"error": "..."} -
        // normalize both (and a body that failed to parse at all) into the
        // one shape every renderer actually checks for.
        const detail = res && (res.error || res.detail || (Array.isArray(res.detail) ? JSON.stringify(res.detail) : null));
        state.lastResult = { error: detail || `Сервер ответил ошибкой (код ${response.status}).` };
      } else if (!res || typeof res !== "object" || !res.nodes) {
        // Any 2xx response that doesn't actually look like a solve result
        // (empty body, wrong shape) must still become a visible error, not
        // silently reach the renderers and crash on missing fields.
        state.lastResult = { error: "Сервер вернул неожиданный ответ на /api/solve." };
      } else {
        state.lastResult = res;
      }
      state.dirty = true;
    } catch (e) {
      state.lastResult = { error: e.message };
    } finally {
      [calcBtn, recalcBtn].forEach((b) => b && (b.disabled = false));
    }
    return true;
  }

  // =========================================================================
  // ЧИСТЫЙ ВЫХОД И НАДБАВКА НА ПЕТЛЮ
  // =========================================================================
  //
  // A chain can eat its own product: «Хлопкоед» needs «Детёныш хлопкоеда», а
  // детёныш делается из хлопкоеда. Part of what the root makes goes straight
  // back into the chain, so a target of 5/сек used to come out as ~2.7/сек of
  // real output plus ~2.3/сек recycled: the person asks for 5 and gets 2.7.
  //
  // So «Целевая скорость» means the NET output (what actually leaves the chain),
  // the whole chain is scaled up until gross - recycled == that number, and the
  // overhead is spelled out on the «Пересчёт» panel.
  //
  //   cascade.targetRate      - NET: what the person typed, or what the parent tab
  //                             needs delivered (set by recalcDescendantTabs).
  //   cascade.grossTargetRate - what the solver is actually asked for.
  //
  // Every relation here is linear in the root rate, so one correction pass lands
  // on the number. Chains without a loop are untouched: the measurement finds
  // used == 0 and nothing is re-solved.

  /** This tab plus every tab whose parent chain leads down from it. */
  function chainTabIds(rootTabId) {
    const ids = [];
    const walk = (id) => {
      if (!id || ids.includes(id)) return;
      ids.push(id);
      for (const t of calcTabs) if (t.parentInfo && t.parentInfo.tabId === id) walk(t.id);
    };
    walk(rootTabId);
    return ids;
  }

  /** Same substance? Items must match exactly; for fluids the temperature part of
   *  the key is not part of the identity (steam@250 and steam@500 are one fluid). */
  function sameSubstance(a, b) {
    if (a === b) return true;
    const pa = parseFluidKey(a);
    const pb = parseFluidKey(b);
    if (!pa || !pb) return false;
    return pa[0] === pb[0];
  }

  /** Do two temperature constraints have anything in common? */
  function tempBandsOverlap(a, b) {
    const pa = parseFluidKey(a);
    const pb = parseFluidKey(b);
    if (!pa || !pb) return a === b;
    return pa[1] <= pb[2] && pb[1] <= pa[2];
  }

  /** What the parent needs for this key - tolerant of temperature spelling.
   *
   *  Chains saved before the ±FLT_MAX sentinel was normalised carry the old
   *  spelling in `parentInfo.itemKey` (`fluid:hot-molten-salt@950:3.4028...e+38`)
   *  while the solver now reports `fluid:hot-molten-salt@950:`, and a strict
   *  lookup found nothing - the feeder tab was then silently solved at ZERO and
   *  the whole chain looked like it needed nothing. Exact key first, then the
   *  same fluid with overlapping temperature limits.
   */
  function rawInputRateFor(result, itemKey) {
    if (!result || !result.rawInputs) return null;
    if (result.rawInputs[itemKey] != null) return result.rawInputs[itemKey];
    for (const [k, v] of Object.entries(result.rawInputs)) {
      if (v > 0 && sameSubstance(k, itemKey) && tempBandsOverlap(k, itemKey)) return v;
    }
    return null;
  }

  /** Сколько ресурса вкладка тянет снаружи: сырьё плюс топливо.
   *
   *  Одного `rawInputs` мало: печь жжёт уголь, и он не входит ни в ингредиенты, ни в
   *  `rawInputs`, но панель «Входящие ресурсы» показывает сумму. Дочерняя вкладка должна
   *  закрывать именно эту сумму (например, 66.67 угля в рецепт + 12.5 в топку = 79.17/сек).
   */
  function tabRawNeed(cascade, result, itemKey) {
    const raw = rawInputRateFor(result, itemKey);
    const fuel = fuelRateFor(cascade, result, itemKey);
    const total = (raw || 0) + fuel;
    return total > 0 ? total : raw;
  }

  /** Топливо этого ресурса с допуском по температуре.
   *
   *  `computeFuelInputs` отдаёт ключи без температуры (`fluid:steam`), а потребность вкладки
   *  может быть с ней (`fluid:steam@250`): точное сравнение потеряло бы топку.
   */
  function fuelRateFor(cascade, result, itemKey) {
    let totals;
    try {
      totals = computeFuelInputs(cascade, result);
    } catch (e) {
      return 0;
    }
    if (totals[itemKey] != null) return totals[itemKey];
    let sum = 0;
    for (const [k, v] of Object.entries(totals)) {
      if (v > 0 && sameSubstance(k, itemKey) && tempBandsOverlap(k, itemKey)) sum += v;
    }
    return sum;
  }

  /** How much of `itemKey` the whole chain behind this tab makes and eats.
   *
   *  Fluids need care: `fluid:hot-molten-salt@1000` (what the root makes) and
   *  `fluid:hot-molten-salt@950:...` (what the feeder asks for) are the same hot
   *  salt but NOT the same string, so comparing keys verbatim made every fluid
   *  loop invisible and the net-output correction silently did nothing. Production
   *  is counted per substance, and a consumption only counts as feedback when the
   *  chain itself makes that fluid at a temperature the demand accepts (a chain
   *  making steam@250 does NOT feed an ingredient that needs steam >= 500 - that
   *  steam has to come from outside).
   */
  function chainItemFlow(rootTabId, itemKey) {
    const activeId = calcTabs[activeTabIndex] && calcTabs[activeTabIndex].id;
    const produced = new Map();
    const consumed = new Map();
    for (const id of chainTabIds(rootTabId)) {
      const res = id === activeId ? state.lastResult : (tabSnapshots[id] || {}).lastResult;
      if (!res || !res.nodes) continue;
      for (const n of Object.values(res.nodes)) {
        for (const [k, v] of Object.entries(n.products || {})) produced.set(k, (produced.get(k) || 0) + v);
        for (const [k, v] of Object.entries(n.ingredients || {})) consumed.set(k, (consumed.get(k) || 0) + v);
      }
    }
    let gross = 0;
    for (const [k, v] of produced) if (sameSubstance(k, itemKey)) gross += v;
    let used = 0;
    for (const [k, v] of consumed) {
      if (!sameSubstance(k, itemKey)) continue;
      for (const pk of produced.keys()) {
        if (fluidOutputSatisfies(pk, k)) {
          used += v;
          break;
        }
      }
    }
    return { gross, used, net: gross - used };
  }

  /** Does any recipe anywhere in this tab's chain take `itemKey` as an ingredient? */
  function chainStructurallyConsumes(rootTabId, itemKey) {
    for (const id of chainTabIds(rootTabId)) {
      const cascade = getTabCascade(id);
      if (!cascade || !cascade.root) continue;
      let hit = false;
      walkTree(cascade.root, (node) => {
        const recipe = state.dataset && state.dataset.recipes[node.recipeName];
        if (!recipe) return;
        for (const ing of asArray(recipe.ingredients)) if (specKey(ing) === itemKey) hit = true;
      });
      if (hit) return true;
    }
    return false;
  }

  /** Scale one tab so that its NET output lands on its target rate. */
  async function settleNetTarget(tabId, passes = 3) {
    const activeId = calcTabs[activeTabIndex] && calcTabs[activeTabIndex].id;
    const isActive = tabId === activeId;
    const cascade = isActive ? state.cascade : (tabSnapshots[tabId] || {}).cascade;
    if (!cascade || !cascade.root || !cascade.root.primaryProduct) return null;
    const itemKey = cascade.root.primaryProduct;
    const want = cascade.targetRate || 0;
    if (!(want > 0)) return null;

    const saved = { cascade: state.cascade, lastResult: state.lastResult, inputPairs: state.inputPairs };
    let flow = chainItemFlow(tabId, itemKey);
    if (!(flow.used > 1e-9) && chainStructurallyConsumes(tabId, itemKey)) {
      // The loop is there on paper but the feeders have not been solved yet (or
      // their results are stale) - measure again once they are.
      await recalcDescendantTabs(tabId);
      flow = chainItemFlow(tabId, itemKey);
    }
    if (!(flow.used > 1e-9) || !(flow.gross > 1e-9)) {
      // Nothing inside this tab's own chain eats what it makes: the plain target
      // already is the net output.
      delete cascade.grossTargetRate;
      return { tabId, itemKey, want, ...flow, factor: 1 };
    }
    try {
      for (let pass = 0; pass < passes; pass++) {
        flow = chainItemFlow(tabId, itemKey);
        if (!(flow.net > 1e-9)) break; // совсем вырожденный случай — не крутимся
        const factor = want / flow.net;
        if (Math.abs(factor - 1) < 1e-6) break;
        const grossNow = cascade.grossTargetRate > 0 ? cascade.grossTargetRate : cascade.targetRate;
        cascade.grossTargetRate = grossNow * factor;
        state.cascade = cascade;
        await runSolve();
        if (isActive) {
          state.inputPairs = {};
          // The propagation below reads the PARENT's result from the snapshot, so
          // the tab we just re-solved has to publish it - otherwise the feeders
          // keep being sized from the previous (smaller) pass and the net never
          // lands on the target.
          saveCurrentTabSnapshot();
        } else {
          tabSnapshots[tabId] = { cascade, lastResult: state.lastResult, inputPairs: {} };
        }
        await recalcDescendantTabs(tabId);
      }
      flow = chainItemFlow(tabId, itemKey);
      return { tabId, itemKey, want, ...flow, factor: flow.net > 1e-9 ? want / flow.net : 1 };
    } finally {
      if (!isActive) {
        state.cascade = saved.cascade;
        state.lastResult = saved.lastResult;
        state.inputPairs = saved.inputPairs;
      }
    }
  }

  /** Settle every tab of this chain (root first, then its feeders). */
  async function settleChainNet(rootTabId) {
    let rootReport = null;
    for (const id of chainTabIds(rootTabId)) {
      const report = await settleNetTarget(id);
      if (report && id === rootTabId) rootReport = report;
    }
    netOutputReport = rootReport && rootReport.used > 1e-9 ? rootReport : null;
    return netOutputReport;
  }

  /** The «Пересчёт» panel line: what leaves the chain and what goes round. */
  function renderNetOutputNote() {
    const box = document.getElementById("netOutputNote");
    if (!box) return;
    const r = netOutputReport;
    if (!r || !(r.used > 1e-9) || !(r.gross > 0)) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    const name = keyDisplayName(state.dataset, r.itemKey);
    const unit = state.cascade.targetRateUnit === "min" ? "/мин" : "/сек";
    const mul = unit === "/мин" ? 60 : 1;
    box.classList.remove("hidden");
    // A CLOSED loop is a real thing in Pyanodon (hot molten salt carries heat and
    // comes back as molten salt, which is then reheated): the chain turns the
    // substance over completely, so nothing of it leaves. Say that instead of
    // printing a meaningless net of zero.
    if (!(r.net > 1e-6)) {
      box.innerHTML =
        `🔁 <b>«${name}» целиком возвращается в цепочку</b>: её вырабатывается ` +
        `<b>${(r.gross * mul).toFixed(2)}${unit}</b> и столько же уходит обратно — ` +
        `<span class="hint">чистого выхода нет, этот контур гоняет вещество по кругу (теплоноситель). ` +
        `Полезное тут — остальные продукты этапов.</span>`;
      return;
    }
    const addPct = (r.used / r.net) * 100;
    box.innerHTML =
      `🔁 <b>«${name}» ходит по кругу</b>: цепочка сама его потребляет. ` +
      `Всего вырабатывается <b>${(r.gross * mul).toFixed(2)}${unit}</b>, обратно в цепочку уходит ` +
      `<b>${(r.used * mul).toFixed(2)}${unit}</b>, чистый выход — <b>${(r.net * mul).toFixed(2)}${unit}</b> ` +
      `<span class="hint">(надбавка +${addPct.toFixed(0)}%: ${(r.gross * mul).toFixed(2)} − ${(r.used * mul).toFixed(2)})</span>`;
  }

  // ================= схема цепочек (панель слева) =================
  //
  // Считается только по открытым вкладкам и ничего не досчитывает: числа берутся из уже
  // посчитанных карточек (/api/solve) и складываются, вычитаются и группируются. Показывает:
  //   • дерево этапов каждой вкладки: иконка продукта сверху, линии к ингредиентам с расходом
  //     в секунду, от каждого свои ветки;
  //   • общие потоки: вещество, которое одни этапы делают, а другие потребляют (в том числе
  //     между вкладками);
  //   • зацикливания: замкнутые контуры веществ (известняк → известь → гашёная известь →
  //     известняк), сколько чего идёт по кругу и сколько залить один раз.
  // Схема рисуется отдельным окном по кнопке «🗺 Схема цепочек».

  /** Группа одного вещества: жидкости сравниваем без температуры
   *  (пар 250° и пар 500° — один и тот же пар, для цепочки это одна труба). */
  function flowSubstanceId(key) {
    const parsed = parseFluidKey(key);
    return parsed ? "fluid:" + parsed[0] : key;
  }

  /** Короткое число для схемы: как на карточках (два знака), но мелкие доли
   *  не превращаются в «0.00». */
  function flowNum(v) {
    const a = Math.abs(v);
    if (!(a > 1e-9)) return "0";
    if (a >= 100) return v.toFixed(1);
    if (a >= 0.01) return v.toFixed(2);
    return String(+v.toPrecision(2));
  }

  /** Количество для заливки: целые — без хвоста (5 шт, а не 5.00 шт). */
  function flowAmount(v) {
    return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : flowNum(v);
  }

  function flowUnit(key) {
    return key.startsWith("fluid:") ? "ед." : "шт";
  }

  /** Открытые вкладки с их деревом и результатом — в порядке вкладок. */
  function flowEntries() {
    const activeId = calcTabs[activeTabIndex] && calcTabs[activeTabIndex].id;
    return calcTabs.map((tab, index) => {
      const cascade = getTabCascade(tab.id) || null;
      const result = getTabLastResult(tab.id) || null;
      return {
        id: tab.id,
        index,
        tab,
        active: tab.id === activeId,
        groupId: tab.groupId || null,
        cascade,
        result,
        root: (cascade && cascade.root) || null,
        error: (result && result.error) || null,
        solved: !!(result && result.nodes && !result.error),
      };
    });
  }

  /** Плоский список этапов всех открытых вкладок, в порядке обхода дерева.
   *  `ancestors`/`last` — только для рисования линий дерева. */
  function flowStages(entries) {
    const stages = [];
    for (const tab of entries) {
      if (!tab.root) continue;
      const walk = (treeNode, ancestors, last) => {
        stages.push({
          key: tab.id + ":" + treeNode.id,
          id: treeNode.id,
          tabId: tab.id,
          tabIndex: tab.index,
          tab,
          node: treeNode,
          result: tab.solved ? tab.result.nodes[treeNode.id] || null : null,
          recipe: (state.dataset && state.dataset.recipes[treeNode.recipeName]) || null,
          ancestors,
          last,
        });
        const kids = Object.entries(treeNode.children || {});
        kids.forEach(([, child], i) => walk(child, ancestors.concat(last), i === kids.length - 1));
      };
      walk(tab.root, [], true);
    }
    return stages;
  }

  /** Модель потоков по открытым вкладкам: вещества, кто делает/ест, контуры. */
  function flowModel() {
    const entries = flowEntries();
    const stages = flowStages(entries);
    const stageByNode = new Map(stages.map((s) => [s.key, s]));
    const groups = new Map();
    const groupOf = (key) => {
      const id = flowSubstanceId(key);
      let g = groups.get(id);
      if (!g) {
        g = {
          id,
          displayKey: key,
          produced: 0,
          consumed: 0,
          fuelConsumed: 0,
          producers: [],
          consumers: [],
          fuelConsumers: [],
          tabs: new Set(),
          demand: 0,
          satisfiable: 0,
          internal: 0,
          external: 0,
          surplus: 0,
          goal: 0,
          loopId: null,
        };
        groups.set(id, g);
      }
      return g;
    };

    const flowLabel = (stage) => (stage && stage.recipe ? recipeDisplayName(stage.recipe) : "?");

    for (const st of stages) {
      if (!st.result) continue;
      for (const [key, rate] of Object.entries(st.result.products || {})) {
        if (!(rate > 1e-9)) continue;
        const g = groupOf(key);
        g.produced += rate;
        g.tabs.add(st.tabId);
        g.producers.push({ key, rate, stage: st, tabId: st.tabId, tabIndex: st.tabIndex, label: flowLabel(st) });
      }
      for (const [key, rate] of Object.entries(st.result.ingredients || {})) {
        if (!(rate > 1e-9)) continue;
        const g = groupOf(key);
        g.consumed += rate;
        g.tabs.add(st.tabId);
        g.consumers.push({
          key,
          rate,
          stage: st,
          tabId: st.tabId,
          tabIndex: st.tabIndex,
          label: flowLabel(st),
          perCraft: st.recipe ? ingredientAmount(st.recipe, key) : 0,
        });
      }
    }

    // Топливо завода — тоже расход снаружи: в ингредиентах рецепта его нет, а
    // панель «Входящие ресурсы» его показывает. Без этого уголь в топку не
    // попадал бы в итог схемы.
    for (const tab of entries) {
      if (!tab.solved) continue;
      let fuel = {};
      try {
        fuel = computeFuelInputs(tab.cascade, tab.result) || {};
      } catch (e) {
        fuel = {};
      }
      for (const [key, rate] of Object.entries(fuel)) {
        if (!(rate > 1e-9)) continue;
        const g = groupOf(key);
        g.fuelConsumed += rate;
        g.tabs.add(tab.id);
        g.fuelConsumers.push({ key, rate, tabId: tab.id, tabIndex: tab.index, label: `топка вкладки ${tab.index + 1}` });
      }
    }

    // Конечный продукт вкладки — не «лишнее»: это то, ради чего вкладка открыта.
    for (const tab of entries) {
      if (!tab.root || !tab.root.primaryProduct) continue;
      groupOf(tab.root.primaryProduct).goal += tab.cascade.targetRate || 0;
    }

    // Сколько из спроса закрывается производством внутри открытых вкладок.
    for (const g of groups.values()) {
      g.demand = g.consumed + g.fuelConsumed;
      let satisfiable = 0;
      for (const c of g.consumers) {
        if (g.producers.some((p) => fluidOutputSatisfies(p.key, c.key))) satisfiable += c.rate;
      }
      for (const c of g.fuelConsumers) {
        if (g.producers.some((p) => fluidOutputSatisfies(p.key, c.key))) satisfiable += c.rate;
      }
      g.satisfiable = satisfiable;
      g.internal = Math.min(g.produced, satisfiable);
      g.external = g.demand - g.internal;
      g.surplus = g.produced - g.internal;
      if (g.external < 1e-9) g.external = 0;
      if (g.surplus < 1e-9) g.surplus = 0;
    }

    // Граф «вещество → вещество»: ребро A→B, если этап ест A и делает B.
    // Замкнутые контуры в этом графе и есть зацикливания.
    const edges = new Map();
    const selfLoops = new Map();
    for (const st of stages) {
      if (!st.result) continue;
      const ings = Object.entries(st.result.ingredients || {}).filter(([, v]) => v > 1e-9);
      const prods = Object.entries(st.result.products || {}).filter(([, v]) => v > 1e-9);
      for (const [ik, irate] of ings) {
        for (const [pk] of prods) {
          const from = flowSubstanceId(ik);
          const to = flowSubstanceId(pk);
          if (from === to) {
            selfLoops.set(from, (selfLoops.get(from) || 0) + irate);
            continue;
          }
          if (!edges.has(from)) edges.set(from, new Set());
          edges.get(from).add(to);
        }
      }
    }

    const loops = [];
    for (const comp of flowStrongComponents(Array.from(groups.keys()), edges)) {
      if (comp.length < 2) continue;
      const inComp = new Set(comp);
      // Этап «в контуре», если он и ест, и делает вещество контура: только его
      // потоки и считаются круговыми. Сторонний потребитель того же вещества
      // (другая вкладка) в баланс контура не лезет — он виден в «Итого снаружи».
      const members = stages.filter((st) => {
        if (!st.result) return false;
        const eats = Object.keys(st.result.ingredients || {}).some((k) => inComp.has(flowSubstanceId(k)));
        const makes = Object.keys(st.result.products || {}).some((k) => inComp.has(flowSubstanceId(k)));
        return eats && makes;
      });
      if (members.length < 2) continue;

      const keys = comp
        .map((id) => {
          const g = groups.get(id);
          let produced = 0;
          let consumed = 0;
          const consumers = [];
          const makers = [];
          for (const st of members) {
            for (const [k, v] of Object.entries(st.result.products || {})) {
              if (v > 1e-9 && flowSubstanceId(k) === id) {
                produced += v;
                makers.push({ stage: st, key: k, rate: v });
              }
            }
            for (const [k, v] of Object.entries(st.result.ingredients || {})) {
              if (v > 1e-9 && flowSubstanceId(k) === id) {
                consumed += v;
                consumers.push({ stage: st, key: k, rate: v, perCraft: st.recipe ? ingredientAmount(st.recipe, k) : 0 });
              }
            }
          }
          const displayKey = (g && g.displayKey) || id;
          return {
            id,
            key: displayKey,
            name: keyDisplayName(state.dataset, displayKey),
            produced,
            consumed,
            balance: produced - consumed,
            consumers,
            makers,
            // Партия этапа: сколько этого вещества этап съедает за один крафт.
            batch: consumers.length ? Math.min(...consumers.map((c) => c.perCraft || 0)) : 0,
          };
        })
        .filter((k) => k.produced > 1e-9 || k.consumed > 1e-9);
      if (keys.length < 2) continue;

      // Порядок ключей по кругу — чтобы заголовок читался как цепочка.
      // Начинаем с того, что выходит ПОБОЧНО у корневого этапа вкладки
      // (известняк у гидроксида натрия): именно он и закрывает контур, с него
      // цепочку видно понятнее всего. Если такого нет — с самого крупного потока.
      const order = [];
      const seen = new Set();
      const rootMade = keys.filter((k) => k.makers.some((m) => m.stage && !m.stage.ancestors.length));
      let cur = (rootMade.length ? rootMade : keys).slice().sort((a, b) => b.produced - a.produced)[0];
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        order.push(cur);
        let nextId = null;
        let nextRate = -1;
        for (const st of members) {
          if (!Object.keys(st.result.ingredients || {}).some((k) => flowSubstanceId(k) === cur.id)) continue;
          for (const [pk, pv] of Object.entries(st.result.products || {})) {
            const pid = flowSubstanceId(pk);
            if (pid === cur.id || !inComp.has(pid) || seen.has(pid) || pv <= 1e-9) continue;
            if (pv > nextRate) {
              nextRate = pv;
              nextId = pid;
            }
          }
        }
        cur = nextId ? keys.find((k) => k.id === nextId) : null;
      }
      for (const k of keys) if (!seen.has(k.id)) order.push(k);

      const bottleneck = order.slice().sort((a, b) => a.produced - b.produced)[0] || null;
      const deficits = keys.filter((k) => k.balance < -1e-9);
      const excess = keys.filter((k) => k.balance > 1e-9);
      // Кто ещё ест вещества контура, кроме самого контура.
      const outside = [];
      for (const id of comp) {
        const g = groups.get(id);
        if (!g) continue;
        for (const c of g.consumers) {
          if (members.includes(c.stage)) continue;
          outside.push({ key: g.displayKey, name: keyDisplayName(state.dataset, g.displayKey), rate: c.rate, label: c.label, tabIndex: c.tabIndex });
        }
        for (const c of g.fuelConsumers) {
          outside.push({ key: g.displayKey, name: keyDisplayName(state.dataset, g.displayKey), rate: c.rate, label: c.label, tabIndex: c.tabIndex });
        }
      }

      const loop = {
        id: "loop" + loops.length,
        keys,
        order,
        members,
        comp,
        bottleneck,
        deficits,
        excess,
        outside,
        // Пропускная способность контура — по самому узкому месту.
        throughput: bottleneck ? bottleneck.produced : 0,
        closed: deficits.length === 0,
        // Заливка на запуск: по одной партии на каждый этап контура. Меньше
        // может хватить, но зависит от размеров партий — с полным набором
        // ни один завод не встанет в ожидании.
        prime: keys
          .filter((k) => k.balance >= -1e-9 && k.batch > 1e-9)
          .sort((a, b) => a.batch - b.batch || b.produced - a.produced)
          .map((k) => ({
            key: k.key,
            name: k.name,
            amount: k.batch,
            unit: flowUnit(k.key),
            stage: (k.consumers[0] && k.consumers[0].stage) || null,
            recipe: k.consumers[0] && k.consumers[0].label ? k.consumers[0].label : null,
          })),
      };
      loops.push(loop);
      for (const id of comp) {
        const g = groups.get(id);
        if (g) g.loopId = loop.id;
      }
    }

    return {
      entries,
      stages,
      stageByNode,
      groups,
      loops,
      selfLoops,
      uncalculated: entries.filter((t) => t.root && !t.solved),
      empty: entries.filter((t) => !t.root),
    };
  }

  /** Что из спроса этого ресурса уже закрыто внутри открытых вкладок.
   *  `share` — какая доля спроса закрыта (для пропорционального вычета). */
  function flowCoverageFor(key) {
    const model = flowModel();
    let g = model.groups.get(flowSubstanceId(key)) || null;
    if (!g) {
      for (const cand of model.groups.values()) {
        if (fluidOutputSatisfies(cand.displayKey, key) || fluidOutputSatisfies(key, cand.displayKey)) {
          g = cand;
          break;
        }
      }
    }
    if (!g || !(g.produced > 1e-9)) return null;
    const share = g.demand > 1e-9 ? Math.min(1, g.internal / g.demand) : 0;
    const loop = g.loopId ? model.loops.find((l) => l.id === g.loopId) || null : null;
    return { group: g, produced: g.produced, internal: g.internal, share, loop, model };
  }

  /** Компоненты сильной связности (итеративный Тарьян) — контуры веществ. */
  function flowStrongComponents(nodes, edges) {
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const out = [];
    let counter = 0;
    for (const start of nodes) {
      if (index.has(start)) continue;
      const work = [{ id: start, i: 0 }];
      while (work.length) {
        const frame = work[work.length - 1];
        const v = frame.id;
        if (frame.i === 0) {
          index.set(v, counter);
          low.set(v, counter);
          counter += 1;
          stack.push(v);
          onStack.add(v);
        }
        const next = Array.from(edges.get(v) || []);
        let recursed = false;
        while (frame.i < next.length) {
          const w = next[frame.i];
          frame.i += 1;
          if (!index.has(w)) {
            work.push({ id: w, i: 0 });
            recursed = true;
            break;
          }
          if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        }
        if (recursed) continue;
        if (low.get(v) === index.get(v)) {
          const comp = [];
          for (;;) {
            const w = stack.pop();
            onStack.delete(w);
            comp.push(w);
            if (w === v) break;
          }
          out.push(comp);
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1];
          low.set(parent.id, Math.min(low.get(parent.id), low.get(v)));
        }
      }
    }
    return out;
  }

  // ---------- схема цепочек: рисуем линиями ----------
  //
  // Это SVG, а не список: сверху продукт вкладки, от него вниз идут линии к
  // ингредиентам, вдоль каждой линии — сколько нужно в секунду и хватает ли
  // этого. Стрелка показывает, КУДА идёт материал (от ингредиента в этап),
  // побочные выходы отходят стрелками вбок, а замыкание контура нарисовано
  // отдельным пунктиром от побочного выхода к тому этапу, который его ест.

  const FLOW_BOX_W = 224;
  const FLOW_BOX_H = 62;
  const FLOW_BY_W = 190;
  const FLOW_BY_H = 62; // та же высота, что у этапа: строка «побочно» + расход
  const FLOW_GAP_X = 30;
  const FLOW_GAP_Y = 58;
  const FLOW_PAD = 20;

  const FLOW_COLOR = {
    ok: "#2f8f46", // хватает: этот ресурс делает своя же цепочка
    loop: "#2470a8", // контур (зацикливание)
    short: "#c0392b", // не хватает
    outside: "#9aa2ad", // берём снаружи лентой/трубой — это не нехватка
    by: "#d9691f", // побочный выход
  };

  function flowEscape(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function flowClip(text, limit = 26) {
    const s = String(text == null ? "" : text);
    return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
  }

  /** «Известь (вкл. 2), ...» — кто делает или ест ресурс. */
  function flowWhoList(flows, limit = 3) {
    const seen = new Set();
    const out = [];
    for (const f of flows || []) {
      const label = f.label || "?";
      const tag = `${label} (вкл. ${(f.tabIndex != null ? f.tabIndex : 0) + 1})`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= limit) break;
    }
    return out.join(", ");
  }

  /** Дочерний этап для этого ингредиента — та же логика, что на сервере
   *  (`_match_child`): точный ключ, а для жидкостей ещё и по температуре. */
  function flowChildFor(children, key) {
    if (!children) return null;
    if (children[key]) return children[key];
    for (const [childKey, child] of Object.entries(children)) {
      if (fluidOutputSatisfies(childKey, key)) return child;
      if (child && child.primaryProduct && fluidOutputSatisfies(child.primaryProduct, key)) return child;
    }
    return null;
  }

  /** Сколько из этой потребности закрыто своими же открытыми вкладками. */
  function flowCoveredShare(group, rate) {
    if (!group || !(group.internal > 1e-9) || !(group.demand > 1e-9)) return 0;
    return Math.min(rate, rate * (group.internal / group.demand));
  }

  /** Состояние ресурса: хватает / не хватает / снаружи / в контуре.
   *  `word` — короткая пометка у числа, `detail` — строка под названием, где
   *  сказано, ОТКУДА ресурс берётся (какая вкладка/рецепт его делает). */
  function flowResourceState(key, rate, model) {
    const g = model.groups.get(flowSubstanceId(key));
    const loop = g && g.loopId ? model.loops.find((l) => l.id === g.loopId) || null : null;
    const covered = flowCoveredShare(g, rate);
    const missing = rate - covered;
    const producer = g && g.producers && g.producers.length ? g.producers[0] : null;
    const producerNote = producer ? `${producer.label} (вкл. ${(producer.tabIndex || 0) + 1})` : null;
    if (covered + 1e-9 >= rate) {
      const inLoop = !!loop;
      return {
        color: inLoop ? FLOW_COLOR.loop : FLOW_COLOR.ok,
        word: inLoop ? `↺${flowLoopNumber(model, loop)}` : "хватает",
        detail: producerNote
          ? `${inLoop ? `контур ↺${flowLoopNumber(model, loop)}: ` : "хватает: "}${flowClip(producerNote, 30)}`
          : inLoop
          ? `контур ↺${flowLoopNumber(model, loop)}`
          : "хватает",
        covered,
        missing: 0,
        loop,
        group: g || null,
      };
    }
    if (covered > 1e-9) {
      return {
        color: FLOW_COLOR.short,
        word: "не хватает",
        detail: `не хватает ${flowNum(missing)}/с${loop ? " — контур не полный" : ""}`,
        covered,
        missing,
        loop,
        group: g || null,
      };
    }
    // Ничего в открытых вкладках этого не делает: обычное внешнее сырьё.
    return {
      color: loop ? FLOW_COLOR.short : FLOW_COLOR.outside,
      word: loop ? "не хватает" : "снаружи",
      detail: loop ? `контур не полный: не хватает ${flowNum(missing)}/с` : "внешний ресурс — везти снаружи",
      covered: 0,
      missing: rate,
      loop,
      group: g || null,
    };
  }

  /** Строим схему: рамки, линии, подписи. Координаты считаем сразу в пикселях. */
  function buildFlowDiagram(model) {
    const boxes = [];
    const edges = [];
    const loopsEdges = [];
    const stageBoxes = new Map(); // "tabId:nodeId" -> box
    const byBoxes = []; // {box, key, stageKey, rate}
    const tabLabels = [];

    const makeBox = (kind, opts) => ({
      kind,
      x: 0,
      y: 0,
      w: kind === "by" ? FLOW_BY_W : FLOW_BOX_W,
      h: FLOW_BOX_H,
      ...opts,
    });

    /** Этап: рамка с продуктом и ветки ингредиентов под ней. */
    const buildStage = (tab, treeNode, productKey, demandRate, isRoot) => {
      const stage = model.stageByNode.get(tab.id + ":" + treeNode.id);
      const res = stage && stage.result;
      if (!res) return null;
      const productName = state.dataset ? keyDisplayName(state.dataset, productKey) : productKey;
      const recipe = stage.recipe;
      const machine = (state.dataset && (state.dataset.entities || {})[res.machineName]) || null;
      const box = makeBox("stage", {
        key: productKey,
        title: productName,
        sub: `${recipe ? recipeDisplayName(recipe) : stage.node.recipeName} · ${
          machine ? machineDisplayName(machine) : res.machineName || "?"
        } ×${res.machinesCeil}`,
        rateText: `${flowNum(demandRate)}/с`,
        root: !!isRoot,
      });
      const node = {
        tab,
        treeNode,
        stage,
        result: res,
        box,
        children: [],
        byproducts: [],
        width: 0,
        height: 0,
        color: FLOW_COLOR.ok,
      };
      if (isRoot) {
        box.badge = `цель вкладки ${tab.index + 1}`;
        box.color = FLOW_COLOR.loop;
      }

      const children = treeNode.children || {};
      const primary = treeNode.primaryProduct || productKey;
      const ingredients = Object.entries(res.ingredients || {})
        .filter(([, v]) => v > 1e-9)
        .sort((a, b) => b[1] - a[1]);
      for (const [key, rate] of ingredients) {
        const child = flowChildFor(children, key);
        const sub = child ? buildStage(tab, child, key, rate, false) : null;
        if (sub) {
          sub.state = flowResourceState(key, rate, model);
          sub.box.color = FLOW_COLOR.loop; // кормит свой этап — значит хватает
          sub.box.stateWord = "свой этап";
          sub.label = `${flowNum(rate)}/с`;
          sub.color = FLOW_COLOR.loop;
          sub.parentBox = box;
          node.children.push(sub);
          continue;
        }
        const st = flowResourceState(key, rate, model);
        const leaf = makeBox("leaf", {
          key,
          title: state.dataset ? keyDisplayName(state.dataset, key) : key,
          sub: st.detail,
          rateText: `${flowNum(rate)}/с`,
          color: st.color,
          stateWord: st.word,
        });
        const leafNode = {
          tab,
          box: leaf,
          children: [],
          byproducts: [],
          width: 0,
          height: 0,
          label: `${flowNum(rate)}/с`,
          color: st.color,
          state: st,
          parentBox: box,
        };
        node.children.push(leafNode);
      }

      // Побочные выходы: то, что этап делает помимо своего продукта.
      for (const [key, rate] of Object.entries(res.products || {})) {
        if (!(rate > 1e-9)) continue;
        if (flowSubstanceId(key) === flowSubstanceId(primary)) continue;
        const g = model.groups.get(flowSubstanceId(key));
        const loop = g && g.loopId ? model.loops.find((l) => l.id === g.loopId) || null : null;
        const eaters = g ? (g.consumers || []).filter((c) => c.stage && c.stage.key !== (stage && stage.key)) : [];
        const byBox = makeBox("by", {
          key,
          title: state.dataset ? keyDisplayName(state.dataset, key) : key,
          sub: eaters.length
            ? `→ ${flowClip(eaters[0].label, 22)}${loop ? ` ↺${flowLoopNumber(model, loop)}` : ""}`
            : "никуда не идёт",
          rateText: `+${flowNum(rate)}/с`,
          color: eaters.length ? FLOW_COLOR.loop : FLOW_COLOR.by,
        });
        const byNode = { box: byBox, key, rate, stageKey: tab.id + ":" + treeNode.id, loop, eaters, color: byBox.color };
        node.byproducts.push(byNode);
        byBoxes.push(byNode);
      }

      stageBoxes.set(tab.id + ":" + treeNode.id, box);
      return node;
    };

    const measure = (node) => {
      const byCount = node.byproducts.length;
      node.byW = byCount ? FLOW_BY_W + 18 : 0;
      node.byH = byCount ? byCount * (FLOW_BY_H + 8) - 8 : 0;
      if (!node.children.length) {
        node.childrenW = 0;
        node.contentTop = 0;
        node.width = node.box.w + node.byW;
        node.height = Math.max(node.box.h, node.byH);
        return node;
      }
      let w = 0;
      for (const child of node.children) {
        measure(child);
        w += child.width;
      }
      w += FLOW_GAP_X * (node.children.length - 1);
      node.childrenW = w;
      node.contentTop = node.box.h + FLOW_GAP_Y;
      let childrenH = 0;
      for (const child of node.children) childrenH = Math.max(childrenH, child.height);
      node.width = Math.max(node.box.w + node.byW, w);
      node.height = Math.max(node.box.h + node.byH, node.contentTop + childrenH);
      return node;
    };

    const place = (node, left, top) => {
      node.box.x = Math.round(left + (node.width - node.box.w - node.byW) / 2);
      node.box.y = top;
      boxes.push(node.box);
      node.byproducts.forEach((by, i) => {
        by.box.x = node.box.x + node.box.w + 18;
        by.box.y = node.box.y + i * (FLOW_BY_H + 8);
        boxes.push(by.box);
        edges.push({
          points: [
            [node.box.x + node.box.w, by.box.y + FLOW_BY_H / 2],
            [by.box.x, by.box.y + FLOW_BY_H / 2],
          ],
          color: by.color,
          arrow: true,
        });
      });
      if (!node.children.length) return;
      const kidsLeft = left + (node.width - node.childrenW) / 2;
      const kidsTop = top + node.contentTop;
      const busY = Math.round(top + node.box.h + FLOW_GAP_Y / 2);
      let x = kidsLeft;
      for (const child of node.children) {
        place(child, x, kidsTop);
        const fromX = Math.round(child.box.x + child.box.w / 2);
        const toX = Math.round(node.box.x + node.box.w / 2);
        edges.push({
          points: [
            [fromX, kidsTop],
            [fromX, busY],
            [toX, busY],
            [toX, top + node.box.h],
          ],
          color: child.color || FLOW_COLOR.ok,
          arrow: true,
          label: child.label || null,
          labelX: fromX,
          labelY: kidsTop - 8,
        });
        x += child.width + FLOW_GAP_X;
      }
    };

    // Вкладки ставим в строку, но переносим на новую, когда строка стала
    // слишком широкой: у цепочки из девяти вкладок иначе вышла бы одна лента
    // в пять тысяч пикселей, которую невозможно окинуть взглядом.
    const MAX_ROW_W = 1800;
    let cursorX = FLOW_PAD;
    let cursorY = FLOW_PAD + 34;
    let rowHeight = 0;
    const roots = [];
    for (const tab of model.entries) {
      if (!tab.root || !tab.solved) {
        if (tab.root) {
          tabLabels.push({ x: cursorX, y: cursorY - 18, text: `Вкладка ${tab.index + 1}: не рассчитана`, broken: true });
          cursorX += 320;
          rowHeight = Math.max(rowHeight, 40);
        }
        continue;
      }
      const root = buildStage(tab, tab.root, tab.root.primaryProduct, tab.cascade.targetRate || 0, true);
      if (!root) continue;
      measure(root);
      if (cursorX > FLOW_PAD && cursorX + root.width > MAX_ROW_W) {
        cursorX = FLOW_PAD;
        cursorY += rowHeight + 40;
        rowHeight = 0;
      }
      place(root, cursorX, cursorY);
      const labelText = `Вкладка ${tab.index + 1} · ${
        state.dataset ? keyDisplayName(state.dataset, tab.root.primaryProduct) : ""
      } ${flowNum(tab.cascade.targetRate || 0)}/с`;
      tabLabels.push({ x: cursorX, y: cursorY - 18, text: labelText, width: root.width });
      roots.push(root);
      // Ширина подписи тоже участвует в раскладке: иначе длинное «Вкладка 5 ·
      // Измельчённый битуминозный песок» налезало на следующую вкладку.
      cursorX += Math.max(root.width, labelText.length * 6.4 + 10) + 46;
      rowHeight = Math.max(rowHeight, root.height);
    }

    // Замыкание контура: от побочного выхода пунктиром к тому этапу, который его ест.
    for (const by of byBoxes) {
      const source = by.box;
      for (const eater of by.eaters) {
        if (!eater.stage) continue;
        const target = stageBoxes.get(eater.stage.key);
        if (!target) continue; // потребитель в другой вкладке — про это скажет карточка контура
        const missing = by.loop
          ? Math.max(0, ...by.loop.keys.filter((k) => flowSubstanceId(k.key) === flowSubstanceId(by.key)).map((k) => -k.balance))
          : 0;
        loopsEdges.push({
          from: [source.x + source.w / 2, source.y + source.h],
          to: [target.x + target.w - 8, target.y + target.h - 6],
          bow: by.box.x + by.box.w + 40,
          color: missing > 1e-9 ? FLOW_COLOR.short : FLOW_COLOR.loop,
          label: `${flowNum(Math.min(by.rate, eater.rate))}/с${missing > 1e-9 ? ` · не хватает ${flowNum(missing)}/с` : ""}`,
        });
      }
    }

    let width = FLOW_PAD;
    let height = FLOW_PAD;
    for (const box of boxes) {
      width = Math.max(width, box.x + box.w);
      height = Math.max(height, box.y + box.h);
    }
    for (const edge of loopsEdges) {
      width = Math.max(width, edge.bow + 20);
      height = Math.max(height, edge.to[1] + 24);
    }

    return {
      boxes,
      edges,
      loopsEdges,
      tabLabels,
      width: Math.round(width + FLOW_PAD),
      height: Math.round(height + FLOW_PAD),
    };
  }

  /** Текст, который гарантированно влезает в отведённую ширину.
   *
   *  SVG сам текст не обрезает: длинное название подрезается по символам, а если всё равно
   *  шире места, SVG его поджимает (textLength + spacingAndGlyphs).
   */
  function flowFit(text, avail, cls, x, y, fill, opts = {}) {
    const value = String(text == null ? "" : text);
    const perChar = cls === "flowBoxLabel" ? 5.9 : cls === "flowEdgeLabel" ? 6.4 : 5.0;
    const width = value.length * perChar;
    const fit = width > avail && avail > 8 ? ` textLength="${avail.toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : "";
    const anchor = opts.anchor ? ` text-anchor="${opts.anchor}"` : "";
    const tip = opts.tip ? `<title>${flowEscape(opts.tip)}</title>` : "";
    return `<text class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${fill}"${anchor}${fit}>${tip}${flowEscape(value)}</text>`;
  }

  /** Рамка этапа/ресурса: иконка, название, расход, состояние.
   *
   *  Текст рамки лежит в группе с обрезкой по границам: ни одна строка не вылезает за рамку.
   */
  function flowBoxSVG(box) {
    const color = box.color || FLOW_COLOR.ok;
    const w = box.w;
    const h = box.h;
    const clipId = `flowClip${Math.round(box.x)}x${Math.round(box.y)}`;
    const frame = [
      `<clipPath id="${clipId}"><rect x="${box.x + 2}" y="${box.y + 2}" width="${w - 4}" height="${h - 4}" rx="6"/></clipPath>`,
      `<rect class="flowBox" x="${box.x}" y="${box.y}" width="${w}" height="${h}" rx="7" fill="var(--panel)" stroke="${color}" stroke-width="${
        box.root ? 2 : 1.2
      }"/>`,
    ];
    if (box.root) frame.push(`<rect x="${box.x}" y="${box.y}" width="${w}" height="4" rx="2" fill="${color}"/>`);
    const icon = box.key && state.dataset ? keyIconUrl(state.dataset, box.key) : null;
    const textLeft = icon ? box.x + 34 : box.x + 10;
    const avail = box.x + w - 8 - textLeft;
    if (icon) {
      frame.push(
        `<image href="${flowEscape(icon)}" xlink:href="${flowEscape(icon)}" x="${box.x + 8}" y="${box.y + 8}" width="22" height="22" preserveAspectRatio="xMidYMid meet"/>`
      );
    }
    const text = [
      flowFit(flowClip(box.title, 30), avail, "flowBoxLabel", textLeft, box.y + 21, "var(--text)", { tip: box.title }),
    ];
    if (box.sub) text.push(flowFit(flowClip(box.sub, 34), avail, "flowBoxSub", textLeft, box.y + 35, "var(--text-dim)"));
    const pillW = Math.max(46, String(box.rateText || "").length * 6.4 + 10);
    text.push(
      `<rect x="${textLeft}" y="${box.y + h - 21}" width="${pillW.toFixed(1)}" height="15" rx="4" fill="${color}" fill-opacity="0.12"/>`,
      flowFit(box.rateText || "", pillW - 8, "flowEdgeLabel", textLeft + 5, box.y + h - 10, color)
    );
    if (box.stateWord) {
      const wordLeft = textLeft + pillW + 6;
      text.push(flowFit(box.stateWord, box.x + w - 8 - wordLeft, "flowBadge", wordLeft, box.y + h - 10, color));
    }
    if (box.badge) {
      const badgeText = flowClip(box.badge, 18);
      text.push(
        flowFit(badgeText, Math.max(40, badgeText.length * 5.2), "flowBadge", box.x + w - 8, box.y + 13, color, {
          anchor: "end",
          tip: box.badge,
        })
      );
    }
    return `${frame.join("")}<g clip-path="url(#${clipId})">${text.join("")}</g>`;
  }

  function flowEdgeSVG(edge) {
    const color = edge.color || FLOW_COLOR.ok;
    const d = edge.points.map((p, i) => `${i === 0 ? "M" : "L"} ${Math.round(p[0])} ${Math.round(p[1])}`).join(" ");
    const marker = edge.arrow ? ` marker-end="url(#flowArrow-${flowMarkersName(color)})"` : "";
    const out = [`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"${marker}/>`];
    if (edge.label) {
      // Подпись на линии — только число: слово состояния живёт в самой рамке,
      // иначе оно налезало на соседнюю ветку.
      const pillW = Math.max(34, edge.label.length * 6.4 + 10);
      out.push(
        `<rect x="${(edge.labelX - pillW / 2).toFixed(1)}" y="${edge.labelY - 11}" width="${pillW.toFixed(1)}" height="14" rx="4" fill="var(--panel)" fill-opacity="0.95"/>`,
        flowFit(edge.label, pillW - 8, "flowEdgeLabel", edge.labelX, edge.labelY, color, { anchor: "middle" })
      );
    }
    return out.join("");
  }

  function flowMarkersName(color) {
    for (const [name, value] of Object.entries(FLOW_COLOR)) if (value === color) return name;
    return "ok";
  }

  function flowDiagramSVG(layout) {
    const markers = Object.entries(FLOW_COLOR)
      .map(
        ([name, color]) =>
          `<marker id="flowArrow-${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker>`
      )
      .join("");
    const labels = layout.tabLabels
      .map((t) =>
        flowFit(flowClip(t.text, 64), Math.max(120, t.width), "flowBoxLabel", t.x + 2, t.y, t.broken ? FLOW_COLOR.short : "var(--text)")
          .replace('class="flowBoxLabel"', 'class="flowBoxLabel" font-size="12"')
      )
      .join("");
    const loopEdges = layout.loopsEdges
      .map((edge) => {
        const [x1, y1] = edge.from;
        const [x2, y2] = edge.to;
        const bow = edge.bow;
        const d = `M ${Math.round(x1)} ${Math.round(y1)} C ${Math.round(bow)} ${Math.round(y1 + 18)}, ${Math.round(bow)} ${Math.round(
          y2 - 18
        )}, ${Math.round(x2)} ${Math.round(y2)}`;
        const midX = Math.round((x1 + bow + x2) / 3 + 16);
        const midY = Math.round((y1 + y2) / 2);
        const text = `↺ ${edge.label}`;
        const pillW = Math.max(40, text.length * 5.6 + 10);
        return `<path d="${d}" fill="none" stroke="${edge.color}" stroke-width="1.6" stroke-dasharray="6 4" marker-end="url(#flowArrow-${flowMarkersName(
          edge.color
        )})"/><rect x="${(midX - pillW / 2).toFixed(1)}" y="${midY - 11}" width="${pillW.toFixed(1)}" height="14" rx="4" fill="var(--panel)" fill-opacity="0.95"/>${flowFit(
          text,
          pillW - 8,
          "flowEdgeLabel",
          midX,
          midY,
          edge.color,
          { anchor: "middle" }
        )}`;
      })
      .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${layout.width}" height="${
      layout.height
    }" viewBox="0 0 ${layout.width} ${layout.height}"><defs>${markers}</defs>${labels}${layout.edges
      .map(flowEdgeSVG)
      .join("")}${loopEdges}${layout.boxes.map(flowBoxSVG).join("")}</svg>`;
  }

  /** Карточки контуров: замкнут или не полный, что залить для запуска. */
  function flowLoopCardsHTML(model) {
    if (!model.loops.length) {
      return `<div class="flowLoopCards"><div class="flowLoopCard broken"><div class="flowLoopHead">↺ контуров нет</div>
        <div class="flowLoopLine">Ни одно вещество открытых вкладок не возвращается назад — замыкать нечего.</div></div></div>`;
    }
    const cards = model.loops.map((loop, i) => {
      const chain = loop.order.map((k) => k.name).join(" → ");
      const first = loop.order[0] ? loop.order[0].name : "?";
      const prime = loop.prime.length
        ? loop.prime
            .map((p) => `<span class="flowPrimeItem">${flowAmount(p.amount)} ${p.unit} «${p.name}»</span>`)
            .join(" + ")
        : "";
      const deficit = loop.deficits.length
        ? `<div class="flowLoopLine flowLoopWarn">⚠ контур НЕ полный: не хватает ${loop.deficits
            .map((k) => `${flowNum(-k.balance)}/с «${k.name}»`)
            .join(", ")} — это придётся докладывать постоянно</div>`
        : `<div class="flowLoopLine">замкнут: по кругу идёт ${flowNum(loop.throughput)}/с${
            loop.bottleneck ? `, узкое место — «${loop.bottleneck.name}»` : ""
          }</div>`;
      const excess = loop.excess.length
        ? `<div class="flowLoopLine">внутри остаётся лишку: ${loop.excess
            .map((k) => `${flowNum(k.balance)}/с «${k.name}»`)
            .join(", ")}</div>`
        : "";
      const outside = loop.outside.length
        ? `<div class="flowLoopLine">кроме контура это же едят: ${loop.outside
            .slice(0, 3)
            .map((o) => `«${o.name}» ${flowNum(o.rate)}/с (${o.label}, вкл. ${(o.tabIndex || 0) + 1})`)
            .join(", ")}</div>`
        : "";
      const primeLine = prime
        ? `<div class="flowLoopLine">🔓 запуск, залить один раз: ${prime}</div>
           <div class="flowLoopLine">по одной партии на каждый этап контура — тогда ни один завод не встанет в ожидании; трубы и буферы не считаю</div>`
        : "";
      return `<div class="flowLoopCard${loop.closed ? "" : " broken"}">
        <div class="flowLoopHead">↺ Контур ${i + 1}: ${chain} → назад в «${first}»</div>
        ${deficit}
        ${excess}
        ${outside}
        ${primeLine}
      </div>`;
    });
    return `<div class="flowLoopCards">${cards.join("")}</div>`;
  }

  /** Итого: что везти снаружи и что остаётся лишним. */
  function flowTotalsHTML(model) {
    const groups = Array.from(model.groups.values());
    const need = groups.filter((g) => g.external > 1e-9).sort((a, b) => b.external - a.external);
    const waste = groups
      .filter((g) => g.surplus - g.goal > 1e-9)
      .sort((a, b) => b.surplus - b.goal - (a.surplus - a.goal));
    const row = (g, value, extra) =>
      `<div class="flowTotalsRow"><span>${state.dataset ? keyDisplayName(state.dataset, g.displayKey) : g.displayKey}</span><span>${flowNum(
        value
      )}/с${extra ? ` <span class="hint">${extra}</span>` : ""}</span></div>`;
    const needHtml = need.length
      ? need
          .map((g) =>
            row(g, g.external, [
              g.internal > 1e-9 ? `часть закрыта своими (${flowNum(g.internal)}/с)` : "",
              g.fuelConsumed > 1e-9 ? `в т.ч. топливо ${flowNum(g.fuelConsumed)}/с` : "",
            ]
              .filter(Boolean)
              .join(", "))
          )
          .join("")
      : `<div class="flowTotalsRow"><span>ничего — всё закрыто открытыми вкладками</span><span></span></div>`;
    const wasteHtml = waste.length
      ? waste
          .map((g) => row(g, g.surplus - g.goal, g.goal > 1e-9 ? `плюс ${flowNum(g.goal)}/с это цель вкладки` : ""))
          .join("")
      : `<div class="flowTotalsRow"><span>ничего лишнего</span><span></span></div>`;
    return `<div class="flowTotals">
      <div class="flowTotalsCol"><div class="flowTotalsHead">везти снаружи (итог по открытым вкладкам)</div>${needHtml}</div>
      <div class="flowTotalsCol"><div class="flowTotalsHead">остаётся, никуда не идёт</div>${wasteHtml}</div>
    </div>`;
  }

  /** Всё содержимое окна схемы: картинка, легенда, контуры, итог. */
  function flowDiagramHTML(model) {
    const layout = buildFlowDiagram(model);
    const drawn = model.entries.filter((t) => t.root && t.solved).length;
    const empty = model.entries.filter((t) => t.root && !t.solved).length;
    const hint = drawn
      ? `Линия — от ингредиента в этап, вдоль линии нужно в секунду. Пунктир — замыкание контура. Масштаб — колесо мыши или кнопки ± в углу.${
          empty ? ` Не рассчитано вкладок: ${empty} — нажми «Пересчитать» на них.` : ""
        }`
      : "Собери цепочку и нажми «Рассчитать» — схема появится здесь.";
    if (!drawn) return `<p class="hint flowDiagramHint">${hint}</p>`;
    const legend = `<div class="flowLegend">
      <span class="flowLegendKey"><span class="flowLegendDash ok"></span> хватает — делает своя цепочка</span>
      <span class="flowLegendKey"><span class="flowLegendDash loop"></span> контур (зацикливание)</span>
      <span class="flowLegendKey"><span class="flowLegendDash short"></span> не хватает</span>
      <span class="flowLegendKey"><span class="flowLegendDash outside"></span> берём снаружи</span>
      <span class="flowLegendKey"><span class="flowLegendDash by"></span> побочный выход</span>
    </div>`;
    return `<p class="hint flowDiagramHint">${hint}</p>
      <div class="flowDiagramScroll" data-w="${layout.width}" data-h="${layout.height}">${flowDiagramSVG(layout)}</div>
      ${legend}
      ${flowLoopCardsHTML(model)}
      ${flowTotalsHTML(model)}`;
  }

  /** Сдвиг прокрутки при перетаскивании схемы: на сколько уехала мышь, на
   *  столько же уезжает картинка (тащим «за содержимое», как в картах). */
  function flowDragShift(drag, event) {
    return {
      left: drag.left - (event.clientX - drag.x),
      top: drag.top - (event.clientY - drag.y),
    };
  }

  function openFlowDiagramModal() {
    if (!state.dataset) {
      alert("Сначала выбери датасет.");
      return;
    }
    let body;
    try {
      body = flowDiagramHTML(flowModel());
    } catch (e) {
      alert(`Схему не собрать: ${e && e.message ? e.message : e}`);
      return;
    }
    const overlay = document.createElement("div");
    overlay.className = "modalOverlay flowOverlay";
    overlay.innerHTML = `<div class="modalPanel flowDiagramPanel">
      <div class="modalHeader">
        <span>Схема цепочек: что куда идёт</span>
        <span class="flowZoomBar">
          <button type="button" class="flowZoomBtn" data-zoom="out" title="Отдалить">−</button>
          <button type="button" class="flowZoomBtn" data-zoom="fit" title="Вписать по ширине окна">по ширине</button>
          <button type="button" class="flowZoomBtn" data-zoom="in" title="Приблизить">+</button>
          <span class="flowZoomPct">100%</span>
        </span>
        <button class="modalClose">✕</button>
      </div>
      <div class="modalBody">${body}</div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector(".modalClose").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    // Масштаб: колесо мыши (вокруг курсора) и кнопки. Картинка векторная, так
    // что на любом масштабе остаётся резкой — меняем только её размер.
    const scroller = overlay.querySelector(".flowDiagramScroll");
    const svg = scroller && scroller.querySelector("svg");
    const pct = overlay.querySelector(".flowZoomPct");
    if (!scroller || !svg) return;
    const baseW = Number(scroller.dataset.w) || 1;
    const baseH = Number(scroller.dataset.h) || 1;
    let zoom = 1;
    const applyZoom = (next, focus) => {
      const box = scroller.getBoundingClientRect();
      const fx = focus ? focus.x : box.width / 2;
      const fy = focus ? focus.y : box.height / 2;
      const cx = (scroller.scrollLeft + fx) / zoom;
      const cy = (scroller.scrollTop + fy) / zoom;
      zoom = Math.min(4, Math.max(0.15, next));
      svg.setAttribute("width", String(Math.round(baseW * zoom)));
      svg.setAttribute("height", String(Math.round(baseH * zoom)));
      scroller.scrollLeft = cx * zoom - fx;
      scroller.scrollTop = cy * zoom - fy;
      if (pct) pct.textContent = `${Math.round(zoom * 100)}%`;
    };
    const fitZoom = () => Math.min(1, (scroller.clientWidth - 8) / baseW);
    applyZoom(fitZoom());
    scroller.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const box = scroller.getBoundingClientRect();
        applyZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX - box.left, y: e.clientY - box.top });
      },
      { passive: false }
    );
    overlay.querySelectorAll(".flowZoomBtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.zoom;
        if (action === "in") applyZoom(zoom * 1.25);
        else if (action === "out") applyZoom(zoom / 1.25);
        else applyZoom(fitZoom());
      });
    });

    // Схему тащат левой кнопкой: она едет внутри своего блока, а не выделяется
    // как текст. Указатель «захватываем», поэтому тащить можно и за пределами
    // окна, и мышь не «отпустит» картинку на полпути.
    let drag = null;
    const stopDrag = (event) => {
      if (!drag) return;
      if (event && event.pointerId != null && event.pointerId !== drag.id) return;
      if (drag.id != null && typeof scroller.releasePointerCapture === "function") {
        try {
          scroller.releasePointerCapture(drag.id);
        } catch (e) {
          void e; // уже отпущен — не беда
        }
      }
      drag = null;
      scroller.classList.remove("flowDragging");
    };
    scroller.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // правая кнопка и колесо — не таскание
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
      scroller.classList.add("flowDragging");
      if (typeof scroller.setPointerCapture === "function" && e.pointerId != null) {
        try {
          scroller.setPointerCapture(e.pointerId);
        } catch (err) {
          void err;
        }
      }
      if (typeof e.preventDefault === "function") e.preventDefault(); // без выделения текста
    });
    scroller.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const next = flowDragShift(drag, e);
      scroller.scrollLeft = next.left;
      scroller.scrollTop = next.top;
      if (typeof e.preventDefault === "function") e.preventDefault();
    });
    scroller.addEventListener("pointerup", stopDrag);
    scroller.addEventListener("pointercancel", stopDrag);
    scroller.addEventListener("lostpointercapture", stopDrag);
    // Картинки внутри SVG браузер умеет «утаскивать» сам — это нам не нужно.
    if (typeof svg.querySelectorAll === "function") {
      svg.querySelectorAll("image").forEach((img) => img.setAttribute("draggable", "false"));
    }
  }

  async function runCalculation() {
    await runSolve();
    state.inputPairs = {}; // force a fresh optimal-pairing suggestion for this calculation
    await settleChainNet(calcTabs[activeTabIndex].id);
    setActiveTab("calc");
    renderResults();
    renderInputResources();
  }

  function clearCurrent() {
    clearChainChest();
    // Сундук по блюпринту к текущей цепочке не относится — чистим и его.
    const bpOut = document.getElementById("bpChestResult");
    if (bpOut) bpOut.innerHTML = "";
    const bpIn = document.getElementById("bpChestInput");
    if (bpIn) bpIn.value = "";
    if (state.mode === "search") {
      const searchInput = document.getElementById("recipeSearch");
      if (searchInput) searchInput.value = "";
      renderRecipeSearch();
    } else if (state.mode === "calc") {
      state.lastResult = null;
      state.inputPairs = {};
      renderResults();
      renderInputResources();
      return;
    }
    // Also drop the current chain root so a fresh search starts clean.
    state.cascade.root = null;
  }

  // ---------- save / share ----------

  /** Подпись цепочки в выпадающем списке — только название, без идентификатора
   *  (выбор идёт по value, а не по подписи).
   */
  function savedChainLabel(chain) {
    const name = chain && chain.name;
    return name ? String(name) : "Без названия";
  }

  /** Сколько сохранённых цепочек показывать в выпадающем списке.
   *
   *  Показываются последние тридцать, сколько ещё есть — в подсказке. Ограничение только для
   *  показа: загрузка, сохранение и поиск цепочки по конечному продукту видят весь список
   *  (pushSaveTarget ищет совпадение среди всех сохранённых, иначе появились бы дубли).
   */
  const SAVED_CHAINS_LIMIT = 30;

  async function refreshSavedChainsList() {
    const list = await apiFetch("/api/chains").then((r) => r.json());
    const sel = document.getElementById("savedChainsSelect");
    const current = sel.value;
    // newest first
    const sorted = list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    sel.innerHTML = `<option value="" data-i18n-ui>— сохранённые цепочки${
      sorted.length > SAVED_CHAINS_LIMIT ? ` (последние ${SAVED_CHAINS_LIMIT} из ${sorted.length})` : ""
    } —</option>`;
    const shown = sorted.slice(0, SAVED_CHAINS_LIMIT);
    // Загруженная сейчас цепочка обязана быть в списке, даже если она старше
    // показанных тридцати: иначе в поле выбора не видно, что вообще открыто.
    if (current && !shown.some((c) => c.id === current)) {
      const extra = sorted.find((c) => c.id === current);
      if (extra) shown.push(extra);
    }
    for (const c of shown) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = savedChainLabel(c);
      // иконка конечного продукта цепочки: файлы лежат по имени, датасет для этого не нужен
      const [finalType, finalName] = c.finalKey ? keyBaseParts(c.finalKey) : [null, null];
      if (finalName && (finalType === "item" || finalType === "fluid")) opt.dataset.icon = `/icons/${finalType}/${finalName}.png`;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
    return list;
  }

  // The chain's FIRST final product - identity of a save. Two chains making
  // different things are different saves, period.
  function currentChainFinalKey() {
    const firstTab = calcTabs[0];
    if (!firstTab) return null;
    const cascade = firstTab.id === calcTabs[activeTabIndex].id ? state.cascade : (tabSnapshots[firstTab.id] || {}).cascade;
    return (cascade && cascade.root && cascade.root.primaryProduct) || null;
  }

  // Which saved chain (if any) this "Сохранить" should UPDATE:
  //  - the chain we loaded, but only while it still makes the same final
  //    product (otherwise we'd overwrite someone else's save with a totally
  //    different chain - the old bug);
  //  - failing that, an existing save for the same final product, and only
  //    after asking;
  //  - otherwise nothing → a brand-new save.
  async function pickSaveTarget(finalKey) {
    let list = [];
    try {
      list = await apiFetch("/api/chains").then((r) => r.json());
    } catch (_) {
      list = [];
    }
    const loaded = state.chainId ? list.find((c) => c.id === state.chainId) : null;
    if (loaded && finalKey && loaded.finalKey === finalKey) return loaded.id;
    if (loaded && !loaded.finalKey && !finalKey) return loaded.id; // both empty/legacy - same thing
    if (!finalKey) return null;
    const sameProduct = list.find((c) => c.finalKey === finalKey);
    if (sameProduct) {
      // Кнопки в окне браузера подписаны «ОК» и «Отмена», поэтому текст сформулирован как
      // «Да» (обновить старую запись) и «Нет» (завести новую).
      const ok = confirm(
        `Уже есть сохранённая цепочка «${sameProduct.name || "Без названия"}» с тем же конечным продуктом.\n\n` +
          `Обновить её?\n\nДа — обновить ту же запись.\nНет — сохранить как НОВУЮ цепочку.`
      );
      if (ok) return sameProduct.id;
    }
    return null; // → create new
  }

  /** Всё, что уходит на сервер при сохранении цепочки (вынесено, чтобы это можно
   *  было проверить тестом — какая лента, какие вкладки, какие группы). */
  function chainSavePayload(name) {
    return {
      name,
      datasetId: state.datasetId,
      solver: "cascade",
      tree: {
        mode: "cascade",
        cascade: state.cascade, // kept for backward compatibility with old saved chains
        tabs: calcTabs.map((t) => ({ id: t.id, cascade: (tabSnapshots[t.id] || {}).cascade, groupId: t.groupId || null, parentInfo: t.parentInfo || null })),
        tabGroups,
        // Лента — часть цепочки: одна на всю цепочку (вход и выход всех вкладок),
        // и после загрузки она должна остаться той же, иначе все ленты в карточках
        // пересчитаются по другой скорости. Старые цепочки поля не имеют — там
        // остаётся текущий выбор.
        belt: { speed: state.belt.speed },
        // Пачка манипуляторов и их скорости — тоже раскладка: от них зависит,
        // сколько манипуляторов нужно на завод. Раздел «Манипуляторы» живёт в
        // localStorage по датасету, а в цепочке дублируем, чтобы не терялся.
        inserterSetup: JSON.parse(JSON.stringify(state.inserterSetup || {})),
        // Настройка чертежа: выход в ту же сторону, что подача, или в другую.
        beltSides: blueprintBeltSides(),
      },
    };
  }

  async function saveChain() {
    if (!state.datasetId) return alert("Нет датасета");
    const name = document.getElementById("chainName").value || "Без названия";
    saveCurrentTabSnapshot();
    const finalKey = currentChainFinalKey();
    const payload = chainSavePayload(name);
    const targetId = await pickSaveTarget(finalKey);
    const wasUpdate = !!targetId;
    const method = wasUpdate ? "PUT" : "POST";
    const url = wasUpdate ? `/api/chains/${targetId}` : "/api/chains";
    let response;
    try {
      response = await apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } catch (e) {
      showErrorBanner(`Не удалось достучаться до сервера, сохранение НЕ прошло: ${e.message}`);
      return;
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await response.json());
      } catch (_) {
        /* ignore */
      }
      showErrorBanner(`Сервер отклонил сохранение (код ${response.status}) ${detail}`.trim());
      return;
    }
    const res = await response.json();
    state.chainId = res.id;
    state.dirty = false;
    const box = document.getElementById("shareLink");
    box.classList.remove("hidden");
    box.textContent = `${wasUpdate ? "Обновлена" : "Сохранена НОВАЯ"} цепочка «${name}» (вкладок: ${calcTabs.length}).`;
    clearTimeout(box._hideTimer);
    box._hideTimer = setTimeout(() => box.classList.add("hidden"), 4000);
    await refreshSavedChainsList();
    document.getElementById("savedChainsSelect").value = res.id;
  }

  async function deleteSelectedChain() {
    const sel = document.getElementById("savedChainsSelect");
    const id = sel.value;
    if (!id) return alert("Выбери сохранённую цепочку в списке, чтобы удалить.");
    if (!confirm("Удалить эту сохранённую цепочку насовсем?")) return;
    await apiFetch(`/api/chains/${id}`, { method: "DELETE" });
    if (state.chainId === id) state.chainId = null;
    await refreshSavedChainsList();
  }

  // Re-solve EVERY tab from the data we have in state (no DOM reading at all).
  // Used after loading a saved chain: the builder's DOM still belongs to
  // whatever chain was on screen before, so anything DOM-driven would poison
  // the freshly loaded numbers. Child/grouped tabs get solved too, so the group
  // panel and the «Сводка» have real results instead of "ещё не рассчитано".
  async function resolveAllTabs() {
    const keepIndex = activeTabIndex;
    saveCurrentTabSnapshot();
    for (let i = 0; i < calcTabs.length; i++) {
      activeTabIndex = i;
      loadTabIntoState(i);
      if (!state.cascade || !state.cascade.root) continue;
      await runSolve();
      state.inputPairs = {};
      saveCurrentTabSnapshot();
    }
    activeTabIndex = Math.min(keepIndex, calcTabs.length - 1);
    loadTabIntoState(activeTabIndex);
  }

  // Keys a saved chain is built around: the primary product of every tab's root.
  function collectReferencedKeys(tree) {
    const keys = [];
    if (!tree) return keys;
    const roots = tree.tabs && tree.tabs.length ? tree.tabs.map((t) => (t.cascade || {}).root) : [(tree.cascade || {}).root];
    for (const r of roots) if (r && r.primaryProduct) keys.push(r.primaryProduct);
    return keys.filter(Boolean);
  }

  /** Which of the chain's products does the selected dataset not have at all?
   *
   *  A key is `type:name`, and for a fluid it may also carry a temperature
   *  (`fluid:hot-molten-salt@1000`). The temperature is a property of the
   *  ingredient/product entry, NOT part of the prototype's name, so looking up a
   *  recipe or an item called "hot-molten-salt@1000" always failed - and loading
   *  such a saved chain was refused with «нет нужных рецептов: fluid:hot-molten-
   *  salt@1000». Strip the temperature (keyBaseParts) and check the dataset's own
   *  tables; a legacy key that names a recipe still counts.
   */
  function missingChainReferences(tree) {
    const refs = collectReferencedKeys(tree);
    if (!refs.length || !state.dataset) return [];
    const recipes = state.dataset.recipes || {};
    const tables = { item: state.dataset.items || {}, fluid: state.dataset.fluids || {} };
    const missing = [];
    let producedKeys = null;
    for (const ref of refs) {
      const raw = String(ref || "");
      const [type, name] = keyBaseParts(raw);
      const legacyRecipeName = raw.includes(":") ? raw.split(/:(.+)/)[1] : raw;
      if (recipes[legacyRecipeName] || recipes[raw]) continue; // legacy: ключ = имя рецепта
      if (tables[type] && tables[type][name]) continue; // датасет знает такой предмет/жидкость
      if (producedKeys === null) {
        producedKeys = new Set();
        for (const r of Object.values(recipes)) {
          for (const p of asArray(r.products)) producedKeys.add(itemKey(p.type || "item", p.name));
        }
      }
      if (producedKeys.has(`${type}:${name}`)) continue; // хоть что-то это производит
      missing.push(ref);
    }
    return missing;
  }

  async function loadSavedChain(chainId) {
    const chain = await apiFetch(`/api/chains/${chainId}`).then((r) => (r.ok ? r.json() : null));
    if (!chain) {
      // Stale/broken link (chain was deleted, or a leftover URL from before
      // "get link" was removed) - strip it from the address bar so it
      // doesn't keep failing on every future reload, and let the caller
      // fall back to auto-loading the last used dataset instead.
      history.replaceState(null, "", location.pathname);
      showErrorBanner("Сохранённая цепочка не найдена (могла быть удалена) — загружаю последний использованный датасет вместо неё.");
      return false;
    }
    state.chainId = chainId;
    // Другая цепочка — старый сундук к ней не относится.
    clearChainChest();
    // И введённые ряды групп тоже: узлы другой цепочки зовутся так же (n1, n2…).
    clearBpRows();
    document.getElementById("chainName").value = chain.name || "";
    // Do not force-switch the user's currently selected dataset.
    // If no dataset is selected, fall back to the one the chain was saved with.
    if (!state.datasetId && chain.datasetId) {
      try {
        await loadDataset(chain.datasetId);
      } catch (e) {
        showErrorBanner(`Датасет ${chain.datasetId} (связанный с этой цепочкой) не найден. Загрузите подходящий датасет вручную.`);
        return false;
      }
    }

    // Validate that the things a saved chain is built around exist in the dataset
    // that is currently selected. Missing ones abort the load.
    const missing = missingChainReferences(chain.tree || {});
    if (missing.length) {
      showErrorBanner(
        `В выбранном датасете нет нужных рецептов: ${missing.join(", ")}. Выберите другой датасет или загрузите соответствующий.`
      );
      return false;
    }
    if (chain.tree.tabs && chain.tree.tabs.length) {
      calcTabs = chain.tree.tabs.map((t) => ({
        id: t.id || "t" + Math.random().toString(36).slice(2),
        groupId: t.groupId || null,
        parentInfo: t.parentInfo || null,
      }));
      for (const key of Object.keys(tabSnapshots)) delete tabSnapshots[key];
      for (const key of Object.keys(tabGroups)) delete tabGroups[key];
      if (chain.tree.tabGroups) Object.assign(tabGroups, chain.tree.tabGroups);
      chain.tree.tabs.forEach((t, idx) => {
        tabSnapshots[calcTabs[idx].id] = {
          cascade: t.cascade || { root: null, targetRate: 1 },
          lastResult: null,
          inputPairs: {},
            };
      });
      activeTabIndex = 0;
      loadTabIntoState(0);
    } else {
      // old single-tab save format
      resetCalcTabs();
      state.cascade = chain.tree.cascade || state.cascade;
      saveCurrentTabSnapshot();
    }
    // Ids of a loaded chain are its own; new nodes must not reuse them.
    syncUidCounter(chain.tree.tabs && chain.tree.tabs.length ? chain.tree.tabs : [state.cascade]);
    // Лента, с которой цепочку сохранили (одна на всю цепочку: вход и выход всех
    // вкладок). В старых цепочках поля нет — тогда остаётся текущий выбор.
    const savedBelt = chain.tree.belt && parseFloat(chain.tree.belt.speed);
    if (savedBelt > 0) {
      state.belt.speed = savedBelt;
      const custom = document.getElementById("beltCustom");
      const isTier = !!document.querySelector(`.beltBtn[data-belt="${savedBelt}"]`);
      if (custom) {
        custom.value = isTier ? "" : savedBelt;
        custom.classList.toggle("active", !isTier);
      }
      document.querySelectorAll(".beltBtn").forEach((b) => b.classList.toggle("active", parseFloat(b.dataset.belt) === savedBelt));
      renderBeltActiveHint(isTier ? null : savedBelt);
    }
    // Пачка и скорости манипуляторов — тоже часть раскладки, поэтому едут в
    // цепочке (в старых цепочках их нет — тогда остаётся то, что лежит в
    // localStorage по датасету).
    if (chain.tree.inserterSetup && typeof chain.tree.inserterSetup === "object") {
      state.inserterSetup = { ...(state.inserterSetup || {}), ...normalizeInserterSetup(chain.tree.inserterSetup) };
      saveInserterSetup();
      renderInserterTable();
    }
    // Настройка чертежа тоже часть цепочки: раскладка с сохранения должна
    // собираться так же, как её собрали. В старых цепочках поля нет — берём «в одну
    // сторону» (текущее умолчание).
    setBeltSides(chain.tree.beltSides || "same");
    // Выбор ленты выхода живёт в блоке «Блюпринт блока» и повторяется во всех
    // открытых панелях — приводим их все к загруженному значению.
    document.querySelectorAll(".beltSidesSelect").forEach((el) => {
      el.value = blueprintBeltSides();
    });
    document.getElementById("shareLink").classList.add("hidden");
    // Recalculate right away, straight from the loaded data - every tab, so a
    // grouped chain comes back exactly as it was saved.
    await resolveAllTabs();
    // ...and then re-derive the dependent tabs from the HEAD tab, exactly like
    // «Пересчитать» does. The saved per-tab rates are written at different
    // moments, so they can disagree with the head tab's rate: the saved "Медная
    // плита" chain came back with its grade-4-copper group producing 2x what the
    // chain actually needs (target 28.571 while the intermediate tab wanted
    // 14.286) until something was recalculated by hand. Groups are re-split as a
    // unit here too - see recalcDescendantTabs.
    if (calcTabs.length > 1) {
      await recalcDescendantTabs(calcTabs[0].id);
    }
    // Same net-output settling as «Пересчитать»: a saved chain that recycles its
    // own product comes back showing the net output it was saved with.
    await settleChainNet(calcTabs[0].id);
    setActiveTab("calc");
    renderResults();
    renderInputResources();
    state.dirty = false; // freshly loaded from disk - nothing unsaved yet
    document.getElementById("savedChainsSelect").value = chainId;
    return true;
  }

  async function loadChainFromUrl() {
    const params = new URLSearchParams(location.search);
    const chainId = params.get("chain");
    if (!chainId) return false;
    return await loadSavedChain(chainId);
  }

  // ---------- wiring ----------

  function setActiveTab(mode) {
    // Пять разделов: "calc" (расчёт — открывается первым), "search" (найти рецепт
    // и начать с него цепочку), "inserters" (таблица манипуляторов —
    // источник правды про пачку и скорость), "bpchest" (сундук запроса по
    // вставленному блюпринту) и "settings" (общие настройки страницы).
    if (!["search", "calc", "inserters", "bpchest", "settings"].includes(mode)) mode = "calc";
    state.mode = mode;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
    document.getElementById("searchView").classList.toggle("hidden", mode !== "search");
    document.getElementById("calcView").classList.toggle("hidden", mode !== "calc");
    document.getElementById("insertersView").classList.toggle("hidden", mode !== "inserters");
    document.getElementById("bpChestView").classList.toggle("hidden", mode !== "bpchest");
    document.getElementById("settingsView").classList.toggle("hidden", mode !== "settings");
    document.getElementById("modeHint").textContent =
      mode === "search"
        ? "найди рецепт по названию (или по тому, что он делает) и начни с него цепочку"
        : mode === "calc"
        ? "таблица заводов/энергии + расчёт лент на вход и выход"
        : mode === "inserters"
        ? "сколько предметов за раз и с какой скоростью тянет каждый манипулятор — отсюда калькулятор берёт все числа про них"
        : mode === "settings"
        ? "общие настройки страницы: что показывать и что учитывать везде"
        : "вставь блюпринт — получишь сундук запроса со всем, что нужно для его постройки";
    if (mode === "inserters") {
      bindInserterTable();
      renderInserterTable();
    }
    if (mode === "settings") {
      renderSettings();
    }
    if (mode === "bpchest") {
      // Поле ввода сразу готово принимать вставку.
      const input = document.getElementById("bpChestInput");
      if (input && !input.value) input.focus();
    }
  }

  window.addEventListener("DOMContentLoaded", async () => {
    // Разметки страницы может не быть (файл подключают отдельно, чтобы добраться
    // до расчётов) — тогда выходим: хук __chainCalcInternals уже выставлен, а
    // обработчики ниже ищут элементы страницы и без них упадут.
    if (!document.getElementById("calcView")) return;
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setActiveTab(t.dataset.mode)));
    document.getElementById("clearBtn").addEventListener("click", () => safeCall(clearCurrent));
    // Схема цепочек — отдельным окном: основная панель остаётся как была.
    const flowDiagramBtn = document.getElementById("flowDiagramBtn");
    if (flowDiagramBtn) flowDiagramBtn.addEventListener("click", () => safeCall(openFlowDiagramModal));
    document.getElementById("saveBtn").addEventListener("click", saveChain);
    document.getElementById("deleteChainBtn").addEventListener("click", () => safeCall(deleteSelectedChain));
    document.getElementById("summaryBtn").addEventListener("click", () => safeCall(openSummaryModal));
    document.getElementById("savedChainsSelect").addEventListener("change", (e) => {
      if (e.target.value) safeCall(() => loadSavedChain(e.target.value));
    });
    document.getElementById("recalcBtn").addEventListener("click", () => safeCall(recalcResults));
    document.getElementById("resultsBody").addEventListener("change", (e) => {
      if (
        e.target.matches(".fuelSelectResult") ||
        e.target.matches(".machineSelectResult") ||
        e.target.matches(".beaconSelect") ||
        e.target.matches(".effSpeed") ||
        e.target.matches(".effProd") ||
        e.target.matches(".effCons")
      ) {
        safeCall(recalcResults);
      }
    });
    document.getElementById("resultsBody").addEventListener("click", (e) => {
      // Свой выпадающий список манипуляторов (в нативном <select> иконок не
      // бывает): кнопка раскрывает список, строка списка — это выбор.
      const insPick = e.target.closest(".inserterPickBtn");
      if (insPick) {
        safeCall(() => toggleInserterMenu(insPick));
        return;
      }
      const insOpt = e.target.closest(".inserterOption");
      if (insOpt) {
        // Выбор устройства — это раскладка, а не производительность: пересчитывать
        // цепочку не нужно, достаточно перерисовать карточку.
        safeCall(() => setStageInserter(insOpt.dataset.node, insOpt.dataset.side, insOpt.dataset.inserter, insOpt.dataset.group));
        return;
      }
      // «Поставить его» в предупреждении про завод, который не скрафтить.
      const machineFix = e.target.closest(".machineReplaceBtn");
      if (machineFix) {
        safeCall(() => setStageMachine(machineFix.dataset.node, machineFix.dataset.machine));
        return;
      }
      if (!e.target.closest(".inserterPicker")) closeInserterMenus();
      const addMod = e.target.closest(".addModuleBtn");
      if (addMod) {
        const target = addMod.classList.contains("addBeaconModuleBtn") ? "beacon" : "machine";
        safeCall(() => openModulePickerModal(addMod.dataset.node, target));
        return;
      }
      const chipMain = e.target.closest(".modChipMain");
      if (chipMain) {
        safeCall(() => openModuleVariantPicker(chipMain.dataset.node, chipMain.dataset.module, chipMain.dataset.target));
        return;
      }
      const rmMod = e.target.closest(".modRemoveBtn");
      if (rmMod) {
        safeCall(() => removeModuleFromNode(rmMod.dataset.node, rmMod.dataset.module, rmMod.dataset.target));
        return;
      }
      const prioBtn = e.target.closest(".beltPriorityBtn");
      if (prioBtn) {
        safeCall(() => toggleStagePriority(prioBtn.dataset.node, prioBtn.dataset.side));
        return;
      }
      const ashBtn = e.target.closest(".ashToggleBtn");
      if (ashBtn) {
        safeCall(() => toggleAshWithOutput(ashBtn.dataset.node));
        return;
      }
      const multiBtn = e.target.closest(".fullBeltMultiBtn");
      if (multiBtn) {
        safeCall(() => applyFullBeltTargetOutput(multiBtn.dataset.node));
        return;
      }
      const recalcNode = e.target.closest('.recalcNodeBtn');
      if (recalcNode) {
        safeCall(() => recalcNodeMachines(recalcNode.dataset.node));
        return;
      }
      const bpBtn = e.target.closest(".blueprintBtn");
      if (bpBtn) {
        safeCall(() => openBlueprintPanel(bpBtn.dataset.node));
        return;
      }
      const bpBuild = e.target.closest(".bpBuildBtn");
      if (bpBuild) {
        safeCall(() => buildBlueprintForStage(bpBuild.dataset.node));
        return;
      }
      const bpZoom = e.target.closest(".bpZoomBtn");
      if (bpZoom) {
        safeCall(() => zoomBlueprintPreview(bpZoom));
        return;
      }
      const bpCopy = e.target.closest(".bpCopyBtn");
      if (bpCopy) {
        safeCall(() => copyBlueprintString(bpCopy));
        return;
      }
      const bpClose = e.target.closest(".bpCloseBtn");
      if (bpClose) {
        safeCall(() => openBlueprintPanel(bpClose.dataset.node)); // повторный клик закрывает
        return;
      }
      // Ряды групп: добавить, убрать.
      const bpAdd = e.target.closest(".bpRowAdd");
      if (bpAdd) {
        safeCall(() => {
          const nodeId = bpAdd.dataset.node;
          const groups = blueprintGroupsForStage(nodeId);
          const total = groups && groups.groups ? groups.groups.length : 0;
          const rows = bpRowsFor(nodeId, total);
          rows.push(1); // новый ряд: одна группа, человек поправит числом
          setBpRows(nodeId, rows);
          rerenderBpRows(nodeId);
        });
        return;
      }
      const bpDel = e.target.closest(".bpRowRemove");
      if (bpDel) {
        safeCall(() => {
          const nodeId = bpDel.dataset.node;
          const groups = blueprintGroupsForStage(nodeId);
          const total = groups && groups.groups ? groups.groups.length : 0;
          const rows = bpRowsFor(nodeId, total);
          if (rows.length > 1) rows.splice(Number(bpDel.dataset.row), 1);
          setBpRows(nodeId, rows);
          rerenderBpRows(nodeId);
        });
        return;
      }
      const btn = e.target.closest(".fullBeltBtn");
      if (!btn) return;
      // Во входе у каждого ресурса — своя кнопка: она разбивает пару (если ресурс
      // едет по общей ленте) и пересчитывает всю цепочку со всеми вкладками.
      safeCall(() => applyFullBeltTargetInput(btn.dataset.node, btn.dataset.key));
    });
    document.getElementById("inputResourceResults").addEventListener("click", (e) => {
      const gb = e.target.closest(".fullBeltGroupBtn");
      if (gb) {
        const keys = (gb.dataset.keys || "").split("|").filter(Boolean);
        if (keys.length) safeCall(() => applyFullBeltTargetGroup(keys));
        return;
      }
      const rb = e.target.closest(".fullBeltResourceBtn");
      if (rb) {
        safeCall(() => applyFullBeltTargetResource(rb.dataset.key));
      }
    });
    // Ряды групп в панели чертежа: числа вводятся руками, поэтому ловим и ввод,
    // и уход из поля (после ввода стирают число, оставляя поле пустым).
    const bpRowsHost = document.getElementById("resultsBody");
    const onBpRowEdit = (e) => {
      const input = e.target.closest && e.target.closest(".bpRowInput");
      if (!input) return;
      safeCall(() => {
        const nodeId = input.dataset.node;
        const groups = blueprintGroupsForStage(nodeId);
        const total = groups && groups.groups ? groups.groups.length : 0;
        const rows = bpRowsFor(nodeId, total);
        rows[Number(input.dataset.row)] = input.value === "" ? null : Math.max(0, Math.trunc(Number(input.value) || 0));
        setBpRows(nodeId, rows);
        updateBpRowsUI(nodeId);
      });
    };
    bpRowsHost.addEventListener("input", onBpRowEdit);
    bpRowsHost.addEventListener("change", onBpRowEdit);
    // Лента выхода: выбор стоит в блоке «Блюпринт блока». Панелей может быть
    // открыто несколько (по одной на этап), поэтому слушаем по классу и
    // синхронизируем все — значение одно на всю цепочку.
    bpRowsHost.addEventListener("change", (e) => {
      const pipesBox = e.target.closest && e.target.closest(".bpPipesBox");
      if (pipesBox) {
        safeCall(() => {
          setBlueprintPipes(pipesBox.checked);
          bpRowsHost.querySelectorAll(".bpPipesBox").forEach((other) => {
            other.checked = blueprintPipes();
          });
          bpRowsHost.querySelectorAll(".bpResult").forEach((el) => {
            el.innerHTML = ""; // собранные чертежи относились к прежней настройке
          });
        });
        return;
      }
      const sel = e.target.closest && e.target.closest(".beltSidesSelect");
      if (!sel) return;
      safeCall(() => {
        setBeltSides(sel.value);
        bpRowsHost.querySelectorAll(".beltSidesSelect").forEach((other) => {
          other.value = blueprintBeltSides();
        });
        // Собранные чертежи относились к прежней настройке: сундук по цепочке и чертежи
        // этапов убираются.
        const chainOut = document.getElementById("chainBlueprintResult");
        if (chainOut) chainOut.innerHTML = "";
        bpRowsHost.querySelectorAll(".bpResult").forEach((el) => {
          el.innerHTML = "";
        });
      });
    });

    // ---------- Маяки section ----------
    const chainBpBtn = document.getElementById("chainBlueprintBtn");
    if (chainBpBtn) chainBpBtn.addEventListener("click", () => safeCall(buildChainBlueprint));
    // «Сборщики всего» — в разделе «Сундук по блюпринту»; результат показывается в своём
    // контейнере, у каждой части своя кнопка копирования.
    const mallBpBtn = document.getElementById("mallBlueprintBtn");
    if (mallBpBtn) mallBpBtn.addEventListener("click", () => safeCall(buildMallBlueprint));
    const mallBpOut = document.getElementById("mallBlueprintResult");
    if (mallBpOut) {
      mallBpOut.addEventListener("click", (e) => {
        const btn = e.target.closest(".bpCopyBtn");
        if (btn) safeCall(() => copyBlueprintString(btn, mallBpOut));
      });
    }
    // Кнопка «Скопировать строку» в этой панели лежит ВНЕ общего контейнера
    // результатов, поэтому у неё свой обработчик.
    const chainBpOut = document.getElementById("chainBlueprintResult");
    if (chainBpOut) {
      chainBpOut.addEventListener("click", (e) => {
        const btn = e.target.closest(".bpCopyBtn");
        // Контейнер передаём явно: панель сундука лежит вне .bpPanel.
        if (btn) safeCall(() => copyBlueprintString(btn, chainBpOut));
      });
    }
    // ---- раздел «Маяки»: строки-маяки, пересчёт сразу при правке ----
    document.getElementById("addBeaconEntryBtn").addEventListener("click", () => safeCall(() => addBeaconRow()));
    document.getElementById("recalcBeaconsBtn").addEventListener("click", () => safeCall(recalcResults));
    const beaconEntriesList = document.getElementById("beaconEntriesList");
    /** Правка маяков сразу пересчитывает цепочку: заводов становится меньше,
     *  и это должно быть видно на месте, а не после нажатия кнопки. */
    const commitBeacons = () => safeCall(commitBeaconEdits);
    beaconEntriesList.addEventListener("click", (e) => {
      const addRow = e.target.closest(".addBeaconRowBtn");
      if (addRow) {
        safeCall(() => addBeaconRow(addRow.dataset.node));
        return;
      }
      const removeRow = e.target.closest(".beaconRowRemove");
      if (removeRow) {
        safeCall(() => removeBeaconRow(removeRow.dataset.node, Number(removeRow.dataset.row)));
        return;
      }
      const addMod = e.target.closest(".addBeaconModuleBtn");
      if (addMod) {
        safeCall(() => openModulePickerModal(addMod.dataset.node, addMod.dataset.target));
        return;
      }
      const rmMod = e.target.closest(".modRemoveBtn");
      if (rmMod) {
        safeCall(() => removeModuleFromNode(rmMod.dataset.node, rmMod.dataset.module, rmMod.dataset.target));
      }
    });
    beaconEntriesList.addEventListener("change", (e) => {
      const factorySel = e.target.closest(".beaconFactorySelect");
      if (factorySel) {
        safeCall(() => {
          collectResultEdits();
          moveBeaconRow(factorySel.dataset.node, Number(factorySel.dataset.row), factorySel.value);
        });
        return;
      }
      if (e.target.matches(".beaconSelect") || e.target.matches(".beaconCovers")) {
        commitBeacons();
      }
    });
    beaconEntriesList.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const inp = e.target.closest(".modQty, .beaconCovers");
      if (!inp) return;
      e.preventDefault();
      inp.blur();
      commitBeacons();
    });
    // Enter on any fluid/gas rate field (input panel or stage cards) commits
    // the new value and rescales the whole chain.
    function onFluidRateKeydown(e) {
      if (e.key !== "Enter") return;
      const inp = e.target.closest(".fluidRateInput");
      if (!inp) return;
      e.preventDefault();
      inp.blur();
      safeCall(() => commitFluidRateEdit(inp));
    }
    document.getElementById("inputResourceResults").addEventListener("keydown", onFluidRateKeydown);
    document.getElementById("resultsBody").addEventListener("keydown", onFluidRateKeydown);
    // Enter in "заводов в группе": use that size (or clear it → automatic).
    document.getElementById("resultsBody").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const inp = e.target.closest(".feedGroupInput");
      if (!inp) return;
      e.preventDefault();
      safeCall(() => commitFeedGroupSize(inp));
    });
    // Enter in a module's quantity field (в заводе или в маяке): подтвердить и
    // пересчитать всю цепочку (и все вкладки, порождённые от неё).
    document.getElementById("resultsBody").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const inp = e.target.closest(".modQty");
      if (!inp) return;
      e.preventDefault();
      inp.blur(); // collectResultEdits reads the DOM, so the value is already in
      safeCall(recalcResults);
    });
    document.getElementById("recalcTargetRateUnit").addEventListener("change", (e) =>
      safeCall(() => {
        const oldUnit = state.cascade.targetRateUnit || "sec";
        const displayed = parseFloat(document.getElementById("recalcTargetRate").value || "0");
        state.cascade.targetRate = oldUnit === "min" ? displayed / 60 : displayed;
        state.cascade.targetRateUnit = e.target.value;
        renderResults();
      })
    );
    document.getElementById("deleteDatasetBtn").addEventListener("click", () => safeCall(deleteCurrentDataset));
    document.getElementById("datasetFile").addEventListener("change", (e) => {
      if (e.target.files[0]) uploadDataset(e.target.files[0]);
    });
    document.getElementById("datasetSelect").addEventListener("change", (e) => {
      if (e.target.value) loadDataset(e.target.value);
    });
    const recipeSearchInput = document.getElementById("recipeSearch");
    if (recipeSearchInput) {
      let searchTimer = 0;
      recipeSearchInput.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => safeCall(renderRecipeSearch), 120);   // not on every key of a 10 000-recipe dump
      });
    }
    const bpChestBtn = document.getElementById("bpChestBtn");
    if (bpChestBtn) bpChestBtn.addEventListener("click", () => safeCall(buildChestFromBlueprint));
    const bpChestOut = document.getElementById("bpChestResult");
    if (bpChestOut) {
      // Кнопка копирования лежит в своей разметке — обработчик свой, с явным
      // контейнером (как у панели сундука на всю цепочку).
      bpChestOut.addEventListener("click", (e) => {
        const btn = e.target.closest(".bpCopyBtn");
        if (btn) safeCall(() => copyBlueprintString(btn, bpChestOut));
      });
    }
    // Клик мимо раскрытого списка манипуляторов (в том числе по панелям слева) и
    // Escape закрывают его — иначе он остаётся висеть поверх карточки.
    document.addEventListener("click", (e) => {
      if (e.target && !e.target.closest(".inserterPicker")) closeInserterMenus();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeInserterMenus();
    });
    document.getElementById("onlyUnlocked").addEventListener("change", (e) =>
      safeCall(() => {
        // Это галочка «Поиска рецепта»: её снятие НЕ трогает настройку «везде» и
        // расчёт — только поиск.
        setSearchUnlocked(e.target.checked);
        renderRecipeFilter();
        renderRecipeSearch();
      })
    );

    const settingsUnlocked = document.getElementById("settingsOnlyUnlocked");
    if (settingsUnlocked) {
      settingsUnlocked.addEventListener("change", (e) =>
        safeCall(() => applySettingsOnlyUnlocked(e.target.checked))
      );
    }

    // Труба для блюпринтов: список открывается кнопкой и закрывается выбором или щелчком мимо.
    document.addEventListener("click", (e) => {
      const pipeBtn = e.target.closest && e.target.closest("#pipePickBtn");
      if (pipeBtn) {
        safeCall(() => togglePipeList());
        return;
      }
      const pipeOption = e.target.closest && e.target.closest(".pipePickOption");
      if (pipeOption) {
        safeCall(() => {
          setPipeType(pipeOption.dataset.pipe);
          renderPipeSetting();
          togglePipeList(false);
          // собранные блюпринты относились к прежней трубе
          document.querySelectorAll(".bpResult").forEach((el) => {
            el.innerHTML = "";
          });
        });
        return;
      }
      if (!(e.target.closest && e.target.closest("#settingsPipePick"))) safeCall(() => togglePipeList(false));
    });

    const settingsHideHints = document.getElementById("settingsHideHints");
    if (settingsHideHints) {
      settingsHideHints.addEventListener("change", (e) =>
        safeCall(() => applyHideHints(e.target.checked))
      );
    }
    applyHideHints(state.hideHints);      // настройка из прошлого раза — применяем сразу

    // belt tier buttons - the dataset's real belts if the dump has them, the
    // vanilla yellow/red/blue markup as a fallback
    bindBeltButtons();
    // Пачка манипуляторов и скорости: раздел «Манипуляторы» — источник правды.
    bindInserterTable();
    renderInserterTable();
    const openIns = document.getElementById("openInserterSection");
    if (openIns) openIns.addEventListener("click", () => safeCall(() => setActiveTab("inserters")));
    document.getElementById("beltCustom").addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (v > 0) {
        state.belt.speed = v;
        state.inputPairs = {};
        state.dirty = true;
        document.querySelectorAll(".beltBtn").forEach((b) => b.classList.remove("active"));
        e.target.classList.add("active");
        renderBeltActiveHint(v);
        renderResults();
        renderInputResources();
      }
    });

    const makeFromHeader = document.getElementById("makeFromHeader");
    if (makeFromHeader) {
      makeFromHeader.addEventListener("click", () => {
        const panel = document.getElementById("makeFromPanel");
        if (panel) panel.classList.toggle("collapsed");
      });
    }

    // ---- вход по коду кабинета ----
    // Отправляем ФОРМУ, а не «нажатие кнопки»: только на submit браузер
    // предлагает сохранить код у себя и потом подставляет его сам.
    const createBtn = document.getElementById("createCabinetBtn");
    if (createBtn) createBtn.addEventListener("click", () => safeCall(createCabinet));
    const loginForm = document.getElementById("loginForm");
    if (loginForm) {
      loginForm.addEventListener("submit", (e) => {
        e.preventDefault();      // страница не должна перезагружаться сама
        safeCall(submitLogin);
      });
    }
    const toggleBtn = document.getElementById("toggleCodeBtn");
    if (toggleBtn) toggleBtn.addEventListener("click", () => safeCall(toggleCodeVisible));
    const copyCodeBtn = document.getElementById("copyCodeBtn");
    if (copyCodeBtn) copyCodeBtn.addEventListener("click", () => safeCall(async () => {
      const code = (document.querySelector("#newCodeBox .codeValue") || {}).textContent || "";
      const ok = await copyTextToClipboard(code);
      copyCodeBtn.textContent = ok ? "Скопировано ✓" : "Не вышло — скопируй вручную";
      setTimeout(() => { copyCodeBtn.textContent = "Скопировать"; }, 2500);
    }));
    const downloadCodeBtn = document.getElementById("downloadCodeBtn");
    if (downloadCodeBtn) downloadCodeBtn.addEventListener("click", () => safeCall(() => {
      const code = (document.querySelector("#newCodeBox .codeValue") || {}).textContent || "";
      if (code) downloadCodeFile(code);
    }));
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", () => safeCall(logoutCabinet));
    const logoutBtn2 = document.getElementById("logoutBtn2");
    if (logoutBtn2) logoutBtn2.addEventListener("click", () => safeCall(logoutCabinet));
    const rotateBtn = document.getElementById("rotateCodeBtn");
    if (rotateBtn) rotateBtn.addEventListener("click", () => safeCall(rotateCabinetCode));

    await startCabinet();
  });

  /** Что делать после входа: подтянуть датасеты, цепочки и открыть раздел.
   *
   * Вынесено из обработчика DOMContentLoaded, потому что тот же путь нужен после
   * входа по коду: обработчики уже повешены, а данные надо загрузить заново.
   */
  async function bootCabinetData() {
    let list = [];
    try {
      list = await refreshDatasetList();
    } catch (e) {
      console.error("refreshDatasetList failed:", e);
    }
    try {
      await refreshSavedChainsList();
    } catch (e) {
      console.error("refreshSavedChainsList failed:", e);
    }

    const params = new URLSearchParams(location.search);
    let chainLoaded = false;
    if (params.get("chain")) {
      try {
        chainLoaded = await loadChainFromUrl();
      } catch (e) {
        console.error("loadChainFromUrl failed:", e);
        showErrorBanner(e.message);
      }
    }
    if (!chainLoaded) {
      try {
        const lastId = localStorage.getItem(LAST_DATASET_KEY);
        if (lastId && list.includes(lastId)) {
          await loadDataset(lastId);
        }
      } catch (e) {
        console.error("auto-loading last dataset failed:", e);
        showErrorBanner(e.message);
      }
    }
    // Открывается раздел из состояния: по умолчанию «Расчёт».
    setActiveTab(state.mode);
  }

  /** Спрашивает у сервера, есть ли кабинет, и показывает либо страницу, либо вход. */
  async function startCabinet() {
    const me = await fetchAccount();
    renderAccount(me);
    const foot = document.getElementById("loginFoot");
    if (foot) {
      foot.textContent = me && me.authRequired === false
        ? "На этом сервере вход выключен (CHAIN_CALC_AUTH=0) — дампы и цепочки общие."
        : `Вход держится ${me && me.sessionDays ? me.sessionDays : 7} дн., потом страница попросит код заново.`;
    }
    // CHAIN_CALC_AUTH=0: no cabinets at all, the page works on the shared folders right away.
    if (me && (me.user || me.authRequired === false)) {
      hideLogin();
      await bootCabinetData();
      return true;
    }
    showLogin("");
    return false;
  }

  /** Вход выполнен: прячем окно и грузим данные кабинета. */
  async function enterCabinet() {
    hideLogin();
    const me = await fetchAccount();
    renderAccount(me);
    await bootCabinetData();
  }

  // ---------------------------------------------------------------------------
  // Test hook. The unit tests (tests/js/*.test.mjs) run in node with a stubbed
  // DOM: they load this file, then reach the pure logic through here. Nothing in
  // the app itself reads this - it exists so that module/beacon/recipe-filter
  // rules can be pinned down by tests instead of by screenshots.
  // ---------------------------------------------------------------------------
  globalThis.__chainCalcInternals = {
    sanitizeDataset,
    state,
    // modules
    buildModuleCatalog,
    moduleCatalogByType,
    moduleDef,
    moduleTypeFitness,
    moduleRulesEvidence,
    moduleEffectsSummary,
    machineModuleSlots,
    machineBaseEffect,
    MODULE_EFFECT_KEYS,
    MODULE_EFFECT_LABELS,
    // effects
    ensureNodeEffects,
    modulesBlockHTML,
    moduleChipHTML,
    moduleCountOnNode,
    buildModuleCatalog,
    recomputeNodeEffects,
    effectsWithMachineBase,
    // beacons
    datasetBeacons,
    beaconTransmission,
    beaconEffects,
    beaconRows,
    beaconTarget,
    parseBeaconTarget,
    isBeaconTarget,
    moduleListFor,
    beaconOfRow,
    beaconLayers,
    beaconLayersRange,
    beaconCapacity,
    beaconCoverage,
    beaconRowMachines,
    beaconsForRow,
    beaconPlanForNode,
    beaconPayloadForNode,
    machinesOfNode,
    beaconSupplyArea,
    parseCoversInput,
    refreshBeaconsPanel,
    commitBeaconEdits,
    addBeaconRow,
    removeBeaconRow,
    moveBeaconRow,
    renderBeaconsSection,
    beaconRowHTML,
    ensureNodeBeacon,
    // recipes / machines
    isJunkRecipe,
    usableRecipes,
    findRecipesProducing,
    recipesConsuming,
    compatibleMachines,
    allMachines,
    sortMachines,
    machineSelectHTML,
    machineCraftWarning,
    machineCraftNoteHTML,
    machineCraftNotesForResult,
    setStageMachine,
    machineUnlocked,
    machineBuildable,
    dumpKindText,
    datasetStatusText,
    inserterNumbersReliable,
    renderInserterDataWarn,
    invalidateRecipeIndex,
    // fuel
    compatibleFuels,
    fuelKind,
    fuelEntry,
    fuelConsumptionPerMachine,
    // item/fluid keys and temperatures
    itemKey,
    specKey,
    fluidKey,
    parseFluidKey,
    fluidOutputSatisfies,
    fluidTempLabel,
    keyBaseParts,
    keyDisplayName,
    keyIconUrl,
    itemDisplayName,
    resolveRecipeProductKey,
    // recipe search
    searchRecipes,
    renderRecipeSearch,
    fillRecipeNames,
    makeDefaultNode,
    renderResults,
    renderStageFeedSection,
    commitFeedGroupSize,
    renderInputResources,
    renderMakeFromPanel,
    renderCalcTabBar,
    renderGroupSummary,
    // схема цепочек (окно по кнопке «Схема цепочек»)
    openFlowDiagramModal,
    flowDiagramHTML,
    flowDiagramSVG,
    buildFlowDiagram,
    flowDragShift,
    flowModel,
    flowEntries,
    flowStages,
    flowCoverageFor,
    flowStrongComponents,
    flowSubstanceId,
    flowNum,
    flowAmount,
    inputResCover,
    // belts / feed / output
    computeBeltPlan,
    beltIdealMachines,
    computeFeedPlan,
    computeCombinedOutputPlan,
    computeSmartBeltPlan,
    computeInputBeltInfo,
    getNodeItemRate,
    applyFullBeltTargetInput,
    applyFullBeltTargetResource,
    chainRawInputRate,
    fullBeltResourceLineButtonHTML,
    fullBeltResourceButtonHTML,
    machineModuleCategories,
    moduleFitsMachine,
    moduleFamily,
    moduleVariants,
    recipeDefaultModule,
    autoFillRecipeModules,
    hostModuleCount,
    moduleCountToAdd,
    removeModuleFromNode,
    moduleTypeFitness,
    moduleRulesEvidence,
    openModuleVariantPicker,
    stageAlignPriority,
    priorityButtonHTML,
    toggleStagePriority,
    renderOutputPriorityBoxHTML,
    stageAshInfo,
    stageAshInfoFor,
    ashWithOutputEnabled,
    combinedOutputItems,    ashToggleButtonHTML,
    toggleAshWithOutput,
    stageSolidInputSplit,
    feedRecipeFuelSplitHTML,
    buildInserterCatalog,
    buildInserterCatalogAll,
    openBlueprintPanel,
    setActiveTab,
    bpChestHTML,
    buildChestFromBlueprint,
    chainBlueprintStages,
    chainBlueprintName,
    chainChestHTML,
    clearChainChest,
    copyTextToClipboard,
    pickBlueprintArea,
    copyBlueprintString,
    buildChainBlueprint,
    mallBlueprintHTML,
    buildMallBlueprint,
    blueprintPanelHTML,
    blueprintPayloadForNode,
    blueprintBeltSides,
    setBeltSides,
    stageFeedPlanFor,
    outputGroupSplit,
    outputFeedGroupsHTML,
    bpRowsFor,
    setBpRows,
    bpRowsCheck,
    bpRowMachineCounts,
    bpRowsHTML,
    blueprintResultHTML,
    requestBlueprint,
    buildBlueprintForStage,
    blueprintModulesFor,
    blueprintGroupsForStage,
    blueprintInserterFromChain,
    blueprintInserterInRows,
    inserterStreamsSafe,
    blueprintDefaultBeltName,
    blueprintPoleList,
    inserterNumbers,
    normalizeInserterSetup,
    blueprintPreviewSVG,
    pipeOptions,
    selectedPipe,
    setPipeType,
    renderPipeSetting,
    blueprintPreviewHTML,
    inserterDumpHandSize,
    inserterSetupFor,
    inserterIsOff,
    inserterDefaultUse,
    buildDeviceCatalogAll,
    computeInserterOffer,
    applyInserterOffer,
    refreshInserterOffer,
    ensureNodeFuel,
    setInserterEnabled,
    setInserterSetup,
    resetInserterSetup,
    resetAllInserterSetup,
    loadInserterSetup,
    saveInserterSetup,
    inserterSpeedUnit,
    speedUnitLabel,
    speedFieldValue,
    inserterSortState,
    setInserterSort,
    loadInserterSort,
    sortInserterRows,
    inserterSortHeaderHTML,
    speedToTurns,
    turnsToSpeed,
    inserterTableRowHTML,
    renderInserterTable,
    bindInserterTable,
    datasetInserterBonus,
    buildLoaderCatalog,
    buildDeviceCatalog,
    inserterThroughput,
    stageInserterItems,
    stageInserterStreams,
    inserterCountFor,
    inserterCountForItem,
    streamInserterCount,
    pluralDevices,
    defaultInserterFor,
    machineRunsOnFuel,
    chosenInserter,
    inserterRowHTML,
    inserterPickerHTML,
    inserterHandChipHTML,
    toggleInserterMenu,
    closeInserterMenus,
    setStageInserter,
    machinesPerBelt,
    machinesPerBeltText,
    maxGroupPhysical,
    balancedSplitFlow,
    feedSoloLineHTML,
    feedPairBoxHTML,
    feedLineAlreadyFull,
    combinedOutputPartHTML,
    renderBeltCell,
    renderItemsBeltCell,
    applyFullBeltTargetGroup,
    applyFullBeltTargetOutput,
    getNeededPerMachine,
    computeFuelInputs,
    stageSolidInputs,
    stageFluidInputs,
    // groups
    getTabTargetRateInSec,
    computeGroupTotal,
    getTabCascade,
    redistributeGroup,
    sizeParentLoops,
    groupTabs,
    ungroupTab,
    estimateGroupInitialTarget,
    recalcResults,
    recalcDescendantTabs,
    repairTabParentLinks,
    tabNeedForItem,
    saveCurrentTabSnapshot,
    settleChainNet,
    settleNetTarget,
    chainItemFlow,
    chainTabIds,
    closeTab,
    dropTabsOutsideChain,
    savedChainLabel,
    refreshSavedChainsList,
    savedChainsLimit: SAVED_CHAINS_LIMIT,
    pickSaveTarget,
    forgetSavedChainId,
    chainNameFromFirstTab,
    sameSubstance,
    tempBandsOverlap,
    rawInputRateFor,
    tabRawNeed,
    fuelRateFor,
    computeFuelInputs,
    renderNetOutputNote,
    netOutputReport() {
      return netOutputReport;
    },
    setNetOutputReport(report) {
      netOutputReport = report;
    },
    setNetOutputReportNull() {
      netOutputReport = null;
    },
    collectReferencedKeys,
    missingChainReferences,
    loadSavedChain,
    chainSavePayload,
    saveChain,
    renderBeltButtons,
    renderBeltActiveHint,
    datasetBelts,
    runSolve,
    allocateIntegerMachines,
    // belts (cont.)
    datasetBelts,
    setDataset(dataset) {
      state.dataset = dataset;
      state.datasetId = "test";
      moduleCatalogCache = null;
      invalidateRecipeIndex();
      delete dataset._allMachines;
      // Ответ «знает ли дамп про изученное» кэшируется на самом объекте дампа
      // (иначе перебор 10 000 рецептов на каждый завод). Копия дампа унаследовала
      // бы чужой ответ — поэтому кэш снимаем: считаем заново.
      delete dataset._knowsUnlocked;
    },
    // Кабинет: окно входа, подписи и разбор списка датасетов.
    renderAccount,
    accountChipText,
    showLogin,
    hideLogin,
    showNewCode,
    codeTextHTML,
    datasetOptionText,
    renderCabinetDatasets,
    fetchAccount,
    apiFetch,
    createCabinet,
    loginByCode,
    submitLogin,
    finishLogin,
    toggleCodeVisible,
    offerToSaveCode,
    logoutCabinet,
    startCabinet,
    enterCabinet,
    account() {
      return state.account;
    },
    setAccount(account) {
      state.account = account;
    },
    // test-only knobs: the tab/group machinery is module-private, and these let a
    // test drive it without a browser.
    setBelt(speed) {
      state.belt.speed = speed;
    },
    setOnlyUnlocked(flag) {
      state.onlyUnlocked = !!flag;
      invalidateRecipeIndex();
    },
    // Настройки: «везде показывать только изученные рецепты» — те же операции,
    // что делает обработчик галочки на странице, но без событий DOM.
    settingsOnlyUnlocked() {
      return !!state.settingsOnlyUnlocked;
    },
    setSettingsOnlyUnlocked(flag) {
      applySettingsOnlyUnlocked(flag);
    },
    // «Убирать описания»: настройка вида страницы (класс на body + localStorage).
    applyHideHints,
    hideHints() {
      return !!state.hideHints;
    },
    datasetKnowsUnlocked,
    unlockedFilterActive,
    renderSettings,
    setTabs(tabs) {
      calcTabs.length = 0;
      for (const t of tabs) calcTabs.push(t);
      for (const key of Object.keys(tabSnapshots)) delete tabSnapshots[key];
      for (const key of Object.keys(tabGroups)) delete tabGroups[key];
    },
    setActiveTabIndex(index) {
      activeTabIndex = index;
    },
    setCascade(cascade) {
      state.cascade = cascade;
    },
    pickProductKey,
    ingredientAmount,
    productAmount,
    ignoredProducers,
    isDestructiveRecipe,
    syncUidCounter,
    openRecipePickerModal,
    recipePickerEmptyHTML,
    mainResourceInfo,
    pickMakeFromRecipe,
    computeCombinedOutputPlan,
    computeBeltPlan,
    applyFullBeltTargetOutput,
    computeFeedPlan,
    setLastResult(result) {
      state.lastResult = result;
    },
    setTabSnapshot(tabId, snapshot) {
      tabSnapshots[tabId] = snapshot;
    },
    tabSnapshot(tabId) {
      return tabSnapshots[tabId];
    },
    setTabGroup(groupId, group) {
      tabGroups[groupId] = group;
    },
    tabGroup(groupId) {
      return tabGroups[groupId];
    },
    groupIds() {
      return Object.keys(tabGroups);
    },
    tabs() {
      return calcTabs;
    },
    activeTabIndex() {
      return activeTabIndex;
    },
  };
})();
