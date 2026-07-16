/*
 * kontract.js — the whole client contract in one small file. Copy it, keep it.
 *
 * Your theme never sees a credential. When launched from Konstruct it runs in
 * a sandboxed iframe and sends each operation to the platform window over
 * postMessage; Konstruct validates the request, makes the API call with the
 * user's session on its own origin, and posts the result back. Standalone
 * (opened directly, no parent), isLaunched() is false — render your welcome
 * or sample-data mode.
 */

const kontract = (() => {
  const embedded = window.parent !== window;
  const pending = new Map();
  let seq = 0;

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || m.type !== "kontract-rpc-result" || !pending.has(m.id)) return;
    const { resolve, reject, timer } = pending.get(m.id);
    pending.delete(m.id);
    clearTimeout(timer);
    if (m.ok) {
      resolve(m.data);
    } else {
      reject(Object.assign(new Error(m.error || "request failed"), { status: m.status }));
    }
  });

  function call(op, ...args) {
    if (!embedded) {
      return Promise.reject(new Error("not launched from Konstruct"));
    }
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error("kontract: request timed out"));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      // The request carries no secrets, so "*" is safe here; the platform
      // replies with targetOrigin pinned to this theme's origin.
      window.parent.postMessage({ type: "kontract-rpc", id, op, args }, "*");
    });
  }

  return {
    isLaunched: () => embedded,
    // Back-compat alias for themes written against the token handoff.
    hasToken: () => embedded,
    discover: (org) => call("discover", org),
    zones: (org) => call("zones", org),
    createZone: (org, zone) => call("createZone", org, zone),
    apps: (org) => call("apps", org),
    appRepos: (org) => call("appRepos", org),
    shipApp: (app) => call("shipApp", app),
    updateApp: (org, name, body) => call("updateApp", org, name, body),
    deleteApp: (org, name) => call("deleteApp", org, name),
    redeploy: (org, name) => call("redeploy", org, name),
    buildLogs: (org, name) => call("buildLogs", org, name),
    metrics: (org, name, opts) => call("metrics", org, name, opts),
    character: (org) => call("character", org),
    saveCharacter: (org, spec) => call("saveCharacter", org, spec),
  };
})();
