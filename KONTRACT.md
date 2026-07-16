# KONTRACT
version: v2
theme: ship-it
profile: game
capabilities: [apps, zones, shop, character, universe]
vocabulary:
  zone: { singular: planet, plural: planets, verb: claim }
  app: { singular: rocket, plural: rockets, verb: launch }
  deploy: { verb: launch }
  shop: { name: "The Ship Shop" }
  universe: { name: "Universe" }

This header is a faithful subset of `theme-manifest.yaml` — the manifest is
the source of truth; regenerate this block from it, never let the two drift.
