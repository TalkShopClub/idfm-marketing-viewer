# IDFM Marketing — Design viewer

Static, public build of the IDFM Marketing design viewer: four hierarchical CAD assets
(Jaguar E-Type roadster, capsule v2 helicopter, Ducati 996 café racer, K1 Brutal Edition)
and 40 generated part alternatives (V8 engine, Torsen differential, manual transmission,
K1 structural frame).

- **Live viewer:** https://talkshopclub.github.io/idfm-marketing-viewer/
- **Example:** https://talkshopclub.github.io/idfm-marketing-viewer/?asset=Jaguar_E_Type_roadster_242824dc#parts/v8_engine/variation_03_seed_50

## Assets

All geometry is hosted publicly on Cloudflare R2 (bucket `sky001-engines-variant`):

```
https://pub-e4ed9ee47da34f439841f3e766930fd6.r2.dev/
├── data/<asset>.{json,bin,full.bin,mesh.bin,display.bin}   whole-asset geometry and hierarchy
├── part-previews/<part>/variation_*.glb                    quick-view meshes
└── alternative-assets/<part>/variation_*.{png,glb}         reference images and full refined meshes
```

`<part>` is one of `v8_engine`, `torsen_differential`, `tremec_transmission`, `k1_structural_frame`.
The asset base URL is set in `config.js`; `alternatives.json` lists every alternative with its R2 URLs.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

## Updating assets

```sh
rclone copy <viewer>/data                r2:sky001-engines-variant/data
rclone copy <viewer>/part-previews       r2:sky001-engines-variant/part-previews
rclone copy <part_alternatives_cad>      r2:sky001-engines-variant/alternative-assets --include '*.glb' --include '*.png'
python3 scripts/build_alternatives_json.py <part_alternatives_cad> <viewer>/part-previews
```

Source: built from `TalkShopClub/idfm_marketing` (`viewer/`).
