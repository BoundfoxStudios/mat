# Changelog

## [1.1.0](https://github.com/BoundfoxStudios/mat/compare/v1.0.0...v1.1.0) (2026-08-21)


### Features

* let the configuration file make --watch the default ([5af4673](https://github.com/BoundfoxStudios/mat/commit/5af4673a912639f98c9c00e4cc995c085623ebb4)), closes [#31](https://github.com/BoundfoxStudios/mat/issues/31)
* re-render and reload the browser on change behind --watch ([4e880f1](https://github.com/BoundfoxStudios/mat/commit/4e880f14b0323750d240bc224f9af545e386e5af)), closes [#31](https://github.com/BoundfoxStudios/mat/issues/31)

## [1.0.0](https://github.com/BoundfoxStudios/mat/compare/v0.1.4...v1.0.0) (2026-08-12)


### Bug Fixes

* namespace the temp directory by user id ([ea403ee](https://github.com/BoundfoxStudios/mat/commit/ea403ee839422a76e540250af4cc6f3f9ec72459))
* read the configuration from %APPDATA% on Windows ([1e3d594](https://github.com/BoundfoxStudios/mat/commit/1e3d5944e906be34989166f7a0e68d0f67342190))


### Miscellaneous Chores

* release 1.0.0 ([76b27b7](https://github.com/BoundfoxStudios/mat/commit/76b27b7bca234453cc83648ff71aa432ef09e21c))

## [0.1.4](https://github.com/BoundfoxStudios/mat/compare/v0.1.3...v0.1.4) (2026-08-12)


### Features

* add a global configuration file for default behavior ([d390075](https://github.com/BoundfoxStudios/mat/commit/d390075316c025ba6a86cd1ff5e50d7955c1791e)), closes [#14](https://github.com/BoundfoxStudios/mat/issues/14) [#15](https://github.com/BoundfoxStudios/mat/issues/15) [#16](https://github.com/BoundfoxStudios/mat/issues/16)

## [0.1.3](https://github.com/BoundfoxStudios/mat/compare/v0.1.2...v0.1.3) (2026-08-12)


### Features

* render linked local Markdown files behind --follow-links ([aa08bdd](https://github.com/BoundfoxStudios/mat/commit/aa08bdde94edfbfd1fbc7ef278c5b731e766aeb0)), closes [#13](https://github.com/BoundfoxStudios/mat/issues/13)


### Bug Fixes

* refuse a non-regular root document instead of hanging ([a3f2a25](https://github.com/BoundfoxStudios/mat/commit/a3f2a25587a946b889c73d2066e8c6e33191ef99)), closes [#17](https://github.com/BoundfoxStudios/mat/issues/17)

## [0.1.2](https://github.com/BoundfoxStudios/mat/compare/v0.1.1...v0.1.2) (2026-08-12)


### Features

* check for a newer release in the background ([2264b4a](https://github.com/BoundfoxStudios/mat/commit/2264b4a1844fc4842a1dd6a30614bb35cbaf7a72))
* log the chosen default document to stderr ([6fe0be4](https://github.com/BoundfoxStudios/mat/commit/6fe0be4e769b41722c5c59eaf03a31043064d5db))
* route CLI diagnostics through consola ([54d3af3](https://github.com/BoundfoxStudios/mat/commit/54d3af3a04db03cb8d788ccfac098441c8d1bb96))


### Bug Fixes

* ship the Oniguruma licence notice alongside the binary ([57ceb43](https://github.com/BoundfoxStudios/mat/commit/57ceb43ea4ca8697d7dc9f57fdb1a37975395bbe))

## [0.1.1](https://github.com/BoundfoxStudios/mat/compare/v0.1.0...v0.1.1) (2026-08-11)


### Features

* render a standard document when no file is given ([61bbb89](https://github.com/BoundfoxStudios/mat/commit/61bbb89108b3d344d73d1ba74d3b3f2c4badb94c))

## 0.1.0 (2026-08-11)


### Features

* render markdown as github-flavored html and open it in the browser ([68596c9](https://github.com/BoundfoxStudios/mat/commit/68596c979d41c659ae1ffb858d9e52644c26a10f))
