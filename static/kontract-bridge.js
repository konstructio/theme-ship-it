/*
 * kontract-bridge — wires the Ship It! prototype to the kontract without
 * touching the game code. The game exposes its logic instance as
 * window.__shipit on mount; this bridge seeds real data into it and wraps
 * the handful of actions that must hit the platform:
 *
 *   planets  <- zones        (claim/buy planet -> POST /kontract/zones)
 *   rockets  <- apps         (register app     -> POST /kontract/app, real
 *                             statuses/URLs polled onto the game state)
 *   hero/XP  <- character    (persist          -> PUT /kontract/character)
 *
 * Cinematics, audio, XP math and the shop fiction stay 100% client-side.
 * Without a launcher session the bridge stands down and the game runs as
 * the original standalone prototype.
 */
(() => {
  const org = new URLSearchParams(location.search).get("org");
  if (!org || typeof kontract === "undefined" || !kontract.hasToken()) return;

  const GIT_BASE = "https://github.com/konstructio/";
  const BAND_CAPS = { small: [10, 10], medium: [20, 20], large: [30, 30] };
  const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

  const zoneToPlanet = (z) => {
    const caps = BAND_CAPS[z.band] || [10, 10];
    const cpu = parseFloat(z.status && z.status.capacity_cpu) || caps[0];
    const mem = parseFloat(z.status && z.status.capacity_memory) || caps[1];
    return {
      id: "zone:" + z.name,
      name: (z.display_name || z.name).toUpperCase(),
      look: Math.abs(hash(z.name)) % 5,
      cpu,
      mem,
      cls: (z.band || "small").toUpperCase(),
      createdAt: Date.now(),
      launches: 0,
      cost: z.free ? 0 : undefined,
    };
  };

  const phaseToStatus = (p) =>
    p === "Live" ? "live" : p === "Failed" ? "failed" : p ? "building" : "watching";

  // Place a rocket on the planet whose zone it actually deploys to, not the
  // first one — the deploy destination must be truthful.
  const planetForZone = (planets, zoneRef) =>
    (zoneRef && planets.find((p) => p.id === "zone:" + zoneRef)) || planets[0] || null;

  const appToGame = (a, planets) => {
    const st = a.status || {};
    const planet = planetForZone(planets, a.zone_ref);
    const buildRef = st.last_build_ref || st.build_sha || "";
    return {
      id: "app:" + a.name,
      name: a.app_name || a.name,
      repo: a.repo_name || "",
      branch: a.branch || "main",
      cpu: 1,
      mem: 1,
      replicas: a.replicas || 1,
      planetId: planet ? planet.id : "",
      status: phaseToStatus(st.phase),
      bg: false,
      launched: st.phase === "Live",
      createdAt: Date.now(),
      history: [],
      checks: 0,
      deploys: 1,
      url: (st.url || "").replace("https://", ""),
      // real platform detail the game's rocket-detail card already renders
      commit: buildRef ? String(buildRef).slice(0, 7) : "",
      imageSha: st.image || "",
      msg: st.message || "",
      lastLaunch: st.phase === "Live" ? Date.now() : null,
    };
  };

  const heroFromCharacter = (c, game) => {
    const ap = c.appearance || {};
    const idx = (k, d) => Number.parseInt(ap["shipit." + k] ?? d, 10) || 0;
    return {
      name: c.display_name || game.state.hero.name,
      species: idx("species", 0),
      helmet: idx("helmet", 1),
      suit: idx("suit", 0),
      cape: idx("cape", 1),
      gadget: idx("gadget", 0),
    };
  };

  const characterFromGame = (s) => ({
    display_name: s.hero.name,
    appearance: {
      "shipit.species": String(s.hero.species),
      "shipit.helmet": String(s.hero.helmet),
      "shipit.suit": String(s.hero.suit),
      "shipit.cape": String(s.hero.cape),
      "shipit.gadget": String(s.hero.gadget),
    },
    xp: s.xp,
    level: s.level,
    quests: Object.keys(s.questsDone || {}).map((q) => ({ key: "shipit." + q })),
    inventory: (s.rockets || []).map((r) => ({ key: "shipit.rocket." + r })),
    equipped: { "shipit.rocket": s.activeRocket || "rust" },
  });

  const start = (game) => {
    // ── seed real state ─────────────────────────────────────────────
    Promise.all([
      kontract.zones(org).catch(() => []),
      kontract.apps(org).catch(() => []),
      kontract.character(org).catch(() => ({})),
    ]).then(([zones, apps, character]) => {
      const zoneList = Array.isArray(zones) ? zones : [];
      const appList = Array.isArray(apps) ? apps : [];
      const planets = zoneList.map(zoneToPlanet);
      const keepLocal = game.state.planets.filter(
        (p) => !planets.some((sp) => sp.name === p.name),
      );
      const allPlanets = planets.concat(keepLocal);
      const gameApps = appList.map((a) => appToGame(a, allPlanets));

      const patch = {
        planets: allPlanets,
        apps: gameApps,
        packsOwned: Math.max(1, game.state.packsOwned),
      };
      if (character && (character.display_name || character.xp)) {
        patch.hero = heroFromCharacter(character, game);
        patch.xp = character.xp || 0;
        patch.level = character.level || 0;
        patch.questsDone = {};
        for (const q of character.quests || []) {
          patch.questsDone[q.key.replace("shipit.", "")] = true;
        }
        patch.rockets = (character.inventory || [])
          .map((i) => i.key.replace("shipit.rocket.", ""))
          .filter(Boolean);
        if (!patch.rockets.length) patch.rockets = ["rust"];
        patch.activeRocket =
          ((character.equipped || {})["shipit.rocket"]) || "rust";
        patch.hasSave = true;
        if (game.state.screen === "title" && patch.hero.name) {
          // returning hero: straight to HQ like a local save would
          patch.screen = game.state.screen;
        }
      }
      game.setState(patch);
    });

    // ── real repo picker: the org's registered repositories ────────
    kontract
      .appRepos(org)
      .then((repos) => {
        const list = (Array.isArray(repos) ? repos : [])
          .map((r) => {
            const name = (r.repo_name || r.name || "").split("/").pop();
            return name ? { v: name, label: name + (r.namespace ? " \u00b7 " + r.namespace : "") } : null;
          })
          .filter(Boolean);
        // Launched mode never shows the prototype's fake repos: an empty org
        // gets an honest pointer at the real fix instead.
        game.REPOS = list.length
          ? list
          : [{ v: "", label: "no repos yet \u00b7 register in Konstruct \u2192 App repositories" }];
      })
      .catch(() => {});

    // ── persist -> character ────────────────────────────────────────
    const origPersist = game.persist.bind(game);
    let saveT = null;
    game.persist = function () {
      origPersist();
      clearTimeout(saveT);
      saveT = setTimeout(() => {
        kontract.saveCharacter(org, characterFromGame(game.state)).catch(() => {});
      }, 1500);
    };

    // ── claim/buy planet -> zone ────────────────────────────────────
    const origClaim = game.claimPlanet.bind(game);
    game.claimPlanet = function () {
      const d = game.state.planetDraft;
      origClaim();
      const name = (d.name || "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (!name) return;
      kontract
        .createZone(org, {
          name,
          display_name: d.name,
          band: (d.cls || "small").toLowerCase() === "medium" ? "medium" : "small",
        })
        .catch((e) => {
          if (!(e && e.status === 409)) {
            game.showToast &&
              game.showToast("ZONE SYNC FAILED", "The platform rejected this planet: " + (e.message || e));
          }
        });
    };

    // ── register app -> real KontractApp ──────────────────────────────
    const origRegister = game.submitRegister.bind(game);
    game.submitRegister = function () {
      const r = game.state.reg;
      const name = (r.name || "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const repo = (r.repo || "").trim();
      origRegister();
      if (!name || !repo) return;
      const repoUrl = repo.includes("://") ? repo : GIT_BASE + repo;
      const repoName = repo.includes("://")
        ? repo.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "")
        : "konstructio/" + repo;
      const planet = game.state.planets.find((p) => p.id === r.planetId);
      const zoneRef = planet && planet.id && planet.id.startsWith("zone:") ? planet.id.slice(5) : "";
      kontract
        .shipApp({
          namespace: org,
          app_name: name,
          environment: "production",
          repo_url: repoUrl,
          repo_name: repoName,
          branch: r.branch || "main",
          port: 8080,
          replicas: r.replicas || 1,
          public_url_enabled: true,
          zone_ref: zoneRef,
          size: "s",
        })
        .catch((e) => {
          game.showToast &&
            game.showToast("SHIP SYNC FAILED", "Platform refused the app: " + (e.message || e));
        });
    };

    // ── scale + relaunch reach the platform for real-backed apps ───
    const realName = (ga) => (ga && ga.id && ga.id.startsWith("app:") ? ga.id.slice(4) : null);

    const origSetReplicas = game.setReplicas.bind(game);
    game.setReplicas = function (id, d) {
      origSetReplicas(id, d);
      const ga = game.state.apps.find((a) => a.id === id);
      const name = realName(ga);
      if (name && ga) {
        kontract.updateApp(org, name, { replicas: ga.replicas }).catch(() => {});
      }
    };

    const origStartLaunch = game.startLaunch.bind(game);
    game.startLaunch = function (appId) {
      const ga = game.state.apps.find((a) => a.id === appId);
      const name = realName(ga);
      origStartLaunch(appId);
      // relaunching an already-delivered app is a real redeploy; first
      // launches are already building from registration
      if (name && ga && ga.launched) {
        kontract.redeploy(org, name).catch(() => {});
      }
    };

    // ── poll real app phases onto the game ──────────────────────────
    setInterval(() => {
      kontract
        .apps(org)
        .then((apps) => {
          const list = Array.isArray(apps) ? apps : [];
          if (!list.length) return;
          const byName = new Map(list.map((a) => [a.app_name || a.name, a]));
          const gameApps = game.state.apps.map((ga) => {
            const real = byName.get(ga.name);
            if (!real) return ga;
            const st = real.status || {};
            const status = phaseToStatus(st.phase);
            const url = (st.url || "").replace("https://", "");
            const buildRef = st.last_build_ref || st.build_sha || "";
            // surface a genuine failure the moment it happens — never hide it
            if (status === "failed" && ga.status !== "failed" && game.showToast) {
              game.showToast(
                "LAUNCH FAILED",
                (ga.name + " — " + (st.message || "the platform reported a failure")).toUpperCase(),
              );
            }
            // never interrupt the cinematic; it settles on its own
            if (game.state.launch && game.state.launch.appId === ga.id) return ga;
            return Object.assign({}, ga, {
              status,
              url: url || ga.url,
              launched: ga.launched || status === "live",
              commit: buildRef ? String(buildRef).slice(0, 7) : ga.commit,
              imageSha: st.image || ga.imageSha,
              msg: st.message || ga.msg,
              lastLaunch: status === "live" && !ga.lastLaunch ? Date.now() : ga.lastLaunch,
            });
          });
          game.setState({ apps: gameApps });
        })
        .catch(() => {});
    }, 15000);
  };

  const wait = setInterval(() => {
    if (window.__shipit) {
      clearInterval(wait);
      start(window.__shipit);
    }
  }, 120);
})();
