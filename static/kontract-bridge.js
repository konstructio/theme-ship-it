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

  // kubernetes quantity -> number (comparable within one dimension)
  const qty = (v) => {
    const m = String(v == null ? "" : v).match(/^([0-9.]+)([a-zA-Z]*)$/);
    if (!m) return NaN;
    const unit =
      { m: 1e-3, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] || 1;
    return parseFloat(m[1]) * unit;
  };

  // Kubernetes quantity -> Konduit's friendly voice ("17Gi" -> "17 GB"),
  // so every theme quotes the org's allowance the same way.
  const prettyQty = (raw) =>
    String(raw == null ? "" : raw)
      .replace(/Gi$/, " GB")
      .replace(/Mi$/, " MB")
      .replace(/Ti$/, " TB")
      .replace(/^([0-9.]+)m$/, (_, n) => String(Math.round((parseFloat(n) / 1000) * 10) / 10));

  // org quota -> HUD meter rows the game can render verbatim
  const quotaBars = (q) => {
    if (!q || !q.capped) return [];
    return [
      ["CPU", q.cpu],
      ["MEM", q.memory],
      ["DISK", q.storage],
    ].map(([k, d]) => {
      const dim = d || {};
      const used = qty(dim.used);
      const limit = qty(dim.limit);
      const pct = limit > 0 && used >= 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
      const fg = pct >= 90 ? "#fb2c37" : pct >= 70 ? "#fdc700" : "#00bcff";
      return { k, pct: pct + "%", fg, v: dim.limit ? prettyQty(dim.used || "0") + "/" + prettyQty(dim.limit) : "∞" };
    });
  };

  // Entitled sizes as known from discover(); appToGame runs before and after
  // discovery resolves, so keep a fallback table of the built-in catalog.
  let entitledSizes = [];
  const SIZE_FALLBACK = { xs: [0.5, 1], s: [1, 1], m: [2, 2], l: [4, 4] };
  const sizeNumbers = (key) => {
    const s = entitledSizes.find((x) => x.key === key);
    if (s) return [qty(s.cpu) || 1, (qty(s.memory) || 2 ** 30) / 2 ** 30];
    return SIZE_FALLBACK[key] || [1, 1];
  };

  // platform refusal -> in-fiction copy the player can act on
  const friendlyError = (e) => {
    const msg = String((e && e.message) || "");
    if (e && (e.status === 403 || e.status === 422) && /quota|allowance|free|limit|exceed/i.test(msg)) {
      return "OUT OF FUEL: the org's free-tier allowance is used up. Decommission a rocket or upgrade the plan.";
    }
    return msg || "the platform said no — try again";
  };

  // zones are purely logical environments now — no bands, no per-zone caps;
  // the org-wide plan quota is the only capacity gate
  const zoneToPlanet = (z) => {
    const cpu = parseFloat(z.status && z.status.capacity_cpu) || 10;
    const mem = parseFloat(z.status && z.status.capacity_memory) || 10;
    return {
      id: "zone:" + z.name,
      name: (z.display_name || z.name).toUpperCase(),
      look: Math.abs(hash(z.name)) % 5,
      cpu,
      mem,
      cls: "ENV",
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
      cpu: sizeNumbers(a.size)[0],
      mem: sizeNumbers(a.size)[1],
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
      // cargo hold (persistent volume) + vanity callsign (custom domain)
      volumeSize: (a.volume && a.volume.size) || "",
      customDomain: a.custom_domain || "",
      domainToken: st.domain_token || "",
      domainVerified: !!st.domain_verified,
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
    // ── platform surface: capabilities, entitled sizes, org quota ───
    const refreshQuota = () => {
      const caps = (game.state.platform || {}).caps || [];
      if (caps.indexOf("quota") === -1) return;
      kontract
        .quota(org)
        .then((q) => {
          // Numeric remaining feeds the planets: org allowance is the ONE
          // pool, so every planet's ceiling is its own usage + this figure.
          let remainCpu = 999;
          let remainMem = 999;
          let limitCpu = null;
          let limitMem = null;
          let usedCpu = 0;
          let usedMem = 0;
          if (q && q.capped) {
            limitCpu = qty(q.cpu && q.cpu.limit) || 0;
            limitMem = ((qty(q.memory && q.memory.limit) || 0)) / 2 ** 30;
            usedCpu = qty(q.cpu && q.cpu.used) || 0;
            usedMem = ((qty(q.memory && q.memory.used) || 0)) / 2 ** 30;
            remainCpu = Math.max(0, limitCpu - usedCpu);
            remainMem = Math.max(0, limitMem - usedMem);
          }
          const platform = Object.assign({}, game.state.platform, {
            quotaBars: quotaBars(q),
            quotaPlan: ((q && q.plan) || "").toUpperCase(),
            quotaRemainCpu: remainCpu,
            quotaRemainMem: remainMem,
            quotaLimitCpu: limitCpu,
            quotaLimitMem: limitMem,
            quotaUsedCpu: usedCpu,
            quotaUsedMem: usedMem,
          });
          game.setState({ platform });
          // setState can commit async — resize with the fresh values in hand
          resizePlanets(platform);
        })
        .catch(() => {});
    };
    // Zones have no caps of their own: each planet's ceiling is what it uses
    // plus the org pool's remainder, so consumption anywhere shrinks headroom
    // everywhere — exactly the platform's admission math.
    const resizePlanets = (platOverride) => {
      const plat = platOverride || game.state.platform || {};
      if (plat.quotaRemainCpu == null) return;
      let changed = false;
      const r1 = (v) => Math.round(v * 10) / 10;
      const planets = game.state.planets.map((p) => {
        if (!(p.id && p.id.indexOf("zone:") === 0)) return p;
        const u = game.usage(p.id);
        // fit math: the real ceiling THIS planet could grow to right now
        const cpu = Math.max(1, Math.ceil(u.cpu + plat.quotaRemainCpu));
        const mem = Math.max(1, Math.ceil(u.mem + plat.quotaRemainMem));
        // card display: one shared org denominator, split into
        // [used elsewhere][used here][free] so every planet agrees
        const orgCpu = plat.quotaLimitCpu != null ? r1(plat.quotaLimitCpu) : null;
        const orgMem = plat.quotaLimitMem != null ? r1(plat.quotaLimitMem) : null;
        const sharedCpu = orgCpu != null ? r1(Math.max(0, plat.quotaUsedCpu - u.cpu)) : null;
        const sharedMem = orgMem != null ? r1(Math.max(0, plat.quotaUsedMem - u.mem)) : null;
        const freeCpu = orgCpu != null ? r1(plat.quotaRemainCpu) : null;
        const freeMem = orgMem != null ? r1(plat.quotaRemainMem) : null;
        if (
          p.cpu === cpu && p.mem === mem && p.orgCpu === orgCpu && p.orgMem === orgMem &&
          p.sharedCpu === sharedCpu && p.sharedMem === sharedMem && p.freeCpu === freeCpu && p.freeMem === freeMem
        ) {
          return p;
        }
        changed = true;
        return Object.assign({}, p, { cpu, mem, orgCpu, orgMem, sharedCpu, sharedMem, freeCpu, freeMem });
      });
      if (changed) game.setState({ planets });
    };

    game.__refreshQuota = refreshQuota;

    kontract
      .discover(org)
      .then((disc) => {
        const caps = (disc && disc.capabilities) || [];
        entitledSizes = (disc && disc.app_sizes) || [];
        game.setState({
          platform: Object.assign({}, game.state.platform, {
            caps,
            sizes: (disc && disc.app_sizes) || [],
            quotaBars: [],
            quotaPlan: "",
          }),
        });
        refreshQuota();
        if (game.__startAppSync) game.__startAppSync();
      })
      .catch(() => {
        // no discovery -> no capability knowledge -> classic polling
        if (game.__startAppSync) game.__startAppSync();
      });

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
      resizePlanets();
    });

    // ── real repo picker: the org's registered repositories ────────
    kontract
      .appRepos(org)
      .then(async (repos) => {
        let list = (Array.isArray(repos) ? repos : [])
          .map((r) => {
            // carry the real identity: without url/full the register path
            // guesses a host and ships a repo that may not exist
            const full = r.repo_name || r.name || "";
            const name = full.split("/").pop();
            return name
              ? { v: name, label: name + (r.namespace ? " \u00b7 " + r.namespace : ""), url: r.repo_url || "", full }
              : null;
          })
          .filter(Boolean);
        if (!list.length) {
          // No registered App Repositories yet — derive the picker from the
          // org's existing apps so re-shipping a known repo always works.
          const apps = await kontract.apps(org).catch(() => []);
          const seen = {};
          list = (Array.isArray(apps) ? apps : [])
            .map((a) => {
              const full = a.repo_name || "";
              const name = full.split("/").pop();
              if (!name || seen[name]) return null;
              seen[name] = true;
              // carry the full identity so shipApp never guesses a host/org
              return { v: full, label: name + " \u00b7 from your apps", url: a.repo_url || "" };
            })
            .filter(Boolean);
        }
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
      const picked = (game.REPOS || []).find((x) => x.v === repo) || {};
      const planet = game.state.planets.find((p) => p.id === r.planetId);
      // environments-first: the platform requires an environment (zone) at
      // registration — no silent fallback, the player picks a real planet
      const zonePlanet =
        planet && planet.id && planet.id.startsWith("zone:")
          ? planet
          : game.state.planets.find((p) => p.id && p.id.startsWith("zone:"));
      const zoneRef = zonePlanet ? zonePlanet.id.slice(5) : "";
      if (name && repo && !zoneRef) {
        game.showToast &&
          game.showToast("NO ENVIRONMENT", "Claim a planet first — every rocket needs a home environment to launch from.");
        return;
      }
      origRegister();
      if (!name || !repo) return;
      const repoUrl = picked.url || (repo.includes("://") ? repo : repo.includes("/") ? "" : GIT_BASE + repo);
      const repoName =
        picked.full ||
        (repo.includes("://")
          ? repo.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "")
          : repo.includes("/")
            ? repo
            : "konstructio/" + repo);
      // entitled sizes come from discover(); never ship a size the plan
      // doesn't allow (the picker only offers entitled keys)
      const sizes = (game.state.platform || {}).sizes || [];
      const size = (r.size && sizes.some((s) => s.key === r.size) && r.size) || (sizes[0] && sizes[0].key) || "s";
      kontract
        .shipApp({
          // environment omitted on purpose: the zone IS the environment and
          // the platform mirrors zone_ref into it
          namespace: org,
          app_name: name,
          repo_url: repoUrl,
          repo_name: repoName,
          branch: r.branch || "main",
          port: 8080,
          replicas: r.replicas || 1,
          public_url_enabled: true,
          zone_ref: zoneRef,
          size,
        })
        .then(() => game.__refreshQuota && game.__refreshQuota())
        .catch((e) => {
          game.showToast && game.showToast("SHIP SYNC FAILED", friendlyError(e));
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
        kontract
          .updateApp(org, name, { replicas: ga.replicas })
          .then(() => game.__refreshQuota && game.__refreshQuota())
          .catch((e) => {
            game.showToast && game.showToast("SCALE SYNC FAILED", friendlyError(e));
          });
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

    // ── engine readouts: real metrics on the rocket detail screen ───
    const fmtPoint = (series, name) => {
      const m = (series || []).find((x) => x.name === name);
      const pts = (m && m.points) || [];
      const last = pts.length ? parseFloat(pts[pts.length - 1][1]) : NaN;
      if (Number.isNaN(last)) return "—";
      if (name === "cpu") return last.toFixed(3) + " CORES";
      if (name === "memory") return (last / 1048576).toFixed(0) + " MB";
      return String(Math.round(last));
    };
    const seriesPoints = (m, name) => {
      const x = ((m && m.series) || []).find((s) => s.name === name);
      return (x && x.points) || [];
    };
    const rawLast = (series, name) => {
      const m = (series || []).find((x) => x.name === name);
      const pts = (m && m.points) || [];
      const last = pts.length ? parseFloat(pts[pts.length - 1][1]) : NaN;
      return Number.isNaN(last) ? null : last;
    };
    const bps = (v) =>
      v == null
        ? null
        : v >= 1048576
          ? (v / 1048576).toFixed(1) + " MB/S"
          : v >= 1024
            ? (v / 1024).toFixed(1) + " KB/S"
            : Math.round(v) + " B/S";
    // usage against its real limit ("0.412 CORES · 41% OF 1.000 CORES")
    const withCeil = (val, limit, fmt) =>
      val == null ? "—" : limit ? fmt(val) + " · " + Math.round((val / limit) * 100) + "% OF " + fmt(limit) : fmt(val);
    const fCpu = (v) => v.toFixed(3) + " CORES";
    const fMem = (v) => (v / 1048576).toFixed(0) + " MB";
    // sparkline feed: refresh cpu/mem series for live apps (best-effort)
    const refreshSparks = () => {
      game.state.apps.forEach((ga) => {
        const name = realName(ga);
        if (!name || ga.status !== "live") return;
        kontract
          .metrics(org, name, { range: "1h", step: "2m" })
          .then((m) => game.mutApp(ga.id, { metricsCpu: seriesPoints(m, "cpu"), metricsMem: seriesPoints(m, "memory") }))
          .catch(() => {});
      });
    };

    // ── live runtime telemetry: logs stream follows the stats screen ─
    let logSub = null;
    let logAppId = null;
    const closeLogs = () => {
      if (logSub) logSub();
      logSub = null;
      logAppId = null;
    };
    const fmtLog = (l) => {
      if (l && typeof l === "object") {
        const pod = l.pod ? String(l.pod).slice(-12) : "";
        const line = l.line != null ? String(l.line) : l.message != null ? String(l.message) : JSON.stringify(l);
        // notice lines arrive without a pod — the stream diagnosing itself
        return pod ? "[" + pod + "] " + line : "◆ " + line;
      }
      return String(l);
    };
    const openLogs = (appId) => {
      const caps = (game.state.platform || {}).caps || [];
      if (caps.indexOf("runtime-logs") === -1 || typeof kontract.logs !== "function") return;
      const ga = game.state.apps.find((a) => a.id === appId);
      const name = realName(ga);
      if (!name) return;
      closeLogs();
      logAppId = appId;
      game.mutApp(appId, { telemetry: { lines: [], closed: "" } });
      logSub = kontract.logs(
        org,
        name,
        (l) => {
          if (game.state.screen !== "appDetail" || game.state.viewAppId !== appId) {
            closeLogs();
            return;
          }
          const t = (game.state.apps.find((a) => a.id === appId) || {}).telemetry || { lines: [] };
          const lines = t.lines.concat(fmtLog(l));
          if (lines.length > 400) lines.splice(0, lines.length - 400);
          game.mutApp(appId, { telemetry: { lines, closed: "" } });
        },
        (reason) => {
          logSub = null;
          const t = (game.state.apps.find((a) => a.id === appId) || {}).telemetry || { lines: [] };
          game.mutApp(appId, {
            telemetry: { lines: t.lines, closed: reason || "stream ended — reconnect to resume" },
          });
        },
      );
    };
    game.__reopenLogs = openLogs;

    // ── cargo hold (persistent volume) + vanity callsign (domain) ───
    game.__attachVolume = (appId, size) => {
      const ga = game.state.apps.find((a) => a.id === appId);
      const name = realName(ga);
      if (!name) return;
      kontract
        .updateApp(org, name, { volume: { size, mount_path: "/data" } })
        .then(() => {
          game.mutApp(appId, { volumeSize: size, replicas: 1 });
          game.showToast && game.showToast("CARGO HOLD ATTACHED", size + " persistent storage — rocket locked to 1 replica.");
          refreshQuota();
        })
        .catch((e) => {
          if (e && e.status === 404) refreshApps();
          game.showToast && game.showToast("CARGO SYNC FAILED", friendlyError(e));
        });
    };
    // value comes from the in-game input — sandboxed iframes block
    // window.prompt/confirm, so no native dialogs
    game.__setDomain = (appId, next) => {
      const ga = game.state.apps.find((a) => a.id === appId);
      const name = realName(ga);
      if (!name) return;
      next = String(next == null ? "" : next).trim();
      if (next === (ga.customDomain || "")) return;
      kontract
        .updateApp(org, name, { custom_domain: next })
        .then(() => {
          game.mutApp(appId, { customDomain: next, domainVerified: false, domainToken: "" });
          if (next) {
            game.showToast && game.showToast("CALLSIGN REGISTERED", "Prove ownership: add the TXT record shown on the rocket screen.");
          }
        })
        .catch((e) => {
          if (e && e.status === 404) refreshApps();
          game.showToast && game.showToast("CALLSIGN SYNC FAILED", friendlyError(e));
        });
    };

    const origOpenStats = game.openAppStats.bind(game);
    game.openAppStats = function (id, from) {
      origOpenStats(id, from);
      game.setState({ domainDraft: null });
      openLogs(id);
      const ga = game.state.apps.find((a) => a.id === id);
      const name = realName(ga);
      if (!name) return;
      kontract
        .buildLogs(org, name)
        .then((bl) => {
          const raw = (bl && bl.logs) || "";
          const tail = raw.split("\n").slice(-30).join("\n").trim();
          game.mutApp(id, { flightLog: tail || "(no build output yet)" });
        })
        .catch(() => {});
      kontract
        .metrics(org, name, { range: "1h", step: "30s" })
        .then((m) => {
          const series = (m && m.series) || [];
          const rx = rawLast(series, "network_rx");
          const tx = rawLast(series, "network_tx");
          game.mutApp(id, {
            readouts: {
              cpu: withCeil(rawLast(series, "cpu"), rawLast(series, "cpu_limit"), fCpu),
              memory: withCeil(rawLast(series, "memory"), rawLast(series, "memory_limit"), fMem),
              net: rx == null && tx == null ? "—" : "RX " + (bps(rx) || "—") + " · TX " + (bps(tx) || "—"),
              pods: fmtPoint(series, "pods"),
              restarts: fmtPoint(series, "restarts"),
            },
          });
        })
        .catch(() => {});
    };

    // ── decommission: the real deleteApp behind the game action ─────
    const origDecommission = game.decommission.bind(game);
    game.decommission = function (appId) {
      const ga = game.state.apps.find((a) => a.id === appId);
      const name = realName(ga);
      if (logAppId === appId) closeLogs();
      origDecommission(appId);
      // origDecommission only proceeds past its confirm() by removing the
      // app — if it is gone from state, the player confirmed.
      if (name && !game.state.apps.some((a) => a.id === appId)) {
        kontract
          .deleteApp(org, name)
          .then(() => game.__refreshQuota && game.__refreshQuota())
          .catch(() => {
            game.showToast && game.showToast("DECOMMISSION SYNC FAILED", "The platform kept " + name + " — it will reappear on the next poll.");
          });
      }
    };

    // ── fuel line: branch changes PATCH the real app ────────────────
    const origChangeBranch = game.changeBranch.bind(game);
    game.changeBranch = function (appId) {
      const before = game.state.apps.find((a) => a.id === appId);
      const prev = before && before.branch;
      origChangeBranch(appId);
      const after = game.state.apps.find((a) => a.id === appId);
      const name = realName(after);
      if (name && after && after.branch !== prev) {
        kontract.updateApp(org, name, { branch: after.branch }).catch(() => {
          game.showToast && game.showToast("FUEL LINE SYNC FAILED", "The platform kept " + (prev || "main") + ".");
          game.mutApp(appId, { branch: prev });
        });
      }
    };

    // ── real app phases onto the game: push-driven, poll fallback ───
    setTimeout(refreshSparks, 2500);
    setInterval(refreshSparks, 30000);
    const refreshApps = () => {
      kontract
        .apps(org)
        .then((apps) => {
          const list = Array.isArray(apps) ? apps : [];
          const prev = game.state.apps;
          const prevById = new Map(prev.map((p) => [p.id, p]));
          const launchId = game.state.launch && game.state.launch.appId;
          // True reconcile against server truth: every real app is present
          // (new ones APPEAR), deleted ones VANISH — no ghost cards to act on.
          // Local per-app state (history, sparks, telemetry) survives a match.
          const next = list.map((real) => {
            const ga = prevById.get("app:" + real.name);
            const st = real.status || {};
            if (!ga) return appToGame(real, game.state.planets);
            // never interrupt the cinematic; it settles on its own
            if (launchId === ga.id) return ga;
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
            // celebrate the ship: the FIRST transition to live plays the
            // full liftoff — the emotional peak must not happen silently
            if (
              status === "live" && !ga.launched && ga.status !== "live" &&
              !game.state.launch && (game.state.screen === "hq" || game.state.screen === "planetDetail")
            ) {
              setTimeout(() => { if (!game.state.launch) origStartLaunch(ga.id); }, 400);
            }
            return Object.assign({}, ga, {
              status,
              url: url || ga.url,
              launched: ga.launched || status === "live",
              commit: buildRef ? String(buildRef).slice(0, 7) : ga.commit,
              imageSha: st.image || ga.imageSha,
              msg: st.message || ga.msg,
              lastLaunch: status === "live" && !ga.lastLaunch ? Date.now() : ga.lastLaunch,
              volumeSize: (real.volume && real.volume.size) || "",
              customDomain: real.custom_domain || "",
              domainToken: st.domain_token || "",
              domainVerified: !!st.domain_verified,
            });
          });
          // standalone fiction apps (non-platform ids) stay; a real app whose
          // liftoff is mid-cinematic gets one grace pass before it disappears
          const keep = prev.filter(
            (p) =>
              !(p.id && p.id.indexOf("app:") === 0) ||
              (p.id === launchId && !list.some((r) => "app:" + r.name === p.id)),
          );
          game.setState({ apps: next.concat(keep) });
          resizePlanets();
          scheduleQuota();
        })
        .catch(() => {});
    };
    let quotaT = null;
    const scheduleQuota = () => {
      clearTimeout(quotaT);
      quotaT = setTimeout(refreshQuota, 800);
    };
    let pollTimer = null;
    const startPolling = () => {
      if (!pollTimer) pollTimer = setInterval(refreshApps, 15000);
    };
    let eventsSub = null;
    const watchApps = () => {
      if (typeof kontract.appEvents !== "function") {
        startPolling();
        return;
      }
      eventsSub = kontract.appEvents(
        org,
        () => refreshApps(),
        (reason) => {
          eventsSub = null;
          // platform without the stream -> permanent poll; transient drop -> resubscribe
          if (/unsupported/i.test(reason || "")) {
            startPolling();
            return;
          }
          setTimeout(watchApps, 5000);
        },
      );
      // one immediate refresh so push-mode starts from current truth
      refreshApps();
    };
    // capability-gated: old platforms ignore stream-opens silently, so only
    // subscribe when discover() advertised app-events; otherwise poll
    game.__startAppSync = () => {
      const caps = (game.state.platform || {}).caps || [];
      if (caps.indexOf("app-events") !== -1) {
        watchApps();
      } else {
        startPolling();
      }
    };
  };

  const wait = setInterval(() => {
    if (window.__shipit) {
      clearInterval(wait);
      start(window.__shipit);
    }
  }, 120);
})();
