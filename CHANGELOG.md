# Changelog

## [1.6.0](https://github.com/contentful-labs/worklog/compare/v1.5.0...v1.6.0) (2026-03-30)


### Features

* add commander to add structured commands ([f979195](https://github.com/contentful-labs/worklog/commit/f97919519fd69ee388acfea0e7f23f9c2f166db4))


### Bug Fixes

* [] Anthropic auth error handling and docs ([400f682](https://github.com/contentful-labs/worklog/commit/400f682cf853784448f7f39161b8c9f004ff3c41))
* clarify Anthropic auth uses Claude Code CLI session ([5331048](https://github.com/contentful-labs/worklog/commit/53310482abff094ee075dc4fe386c13d3eeb8b4c))
* cover both Claude Code users and new users in auth docs ([158fdf6](https://github.com/contentful-labs/worklog/commit/158fdf6eda790739b62539029b408166adc8c20f))
* improve Anthropic auth error handling with setup instructions ([7397893](https://github.com/contentful-labs/worklog/commit/739789340accdb5f0baccff764798c4822d890cd))
* support ANTHROPIC_API_KEY without requiring Claude Code CLI ([444d17c](https://github.com/contentful-labs/worklog/commit/444d17cf6995ceedcd8322e67429e364084dc504))

## [1.5.0](https://github.com/contentful-labs/worklog/compare/v1.4.0...v1.5.0) (2026-03-08)


### Features

* [] add --verbose/-v flag for detailed runtime logging ([d3884a9](https://github.com/contentful-labs/worklog/commit/d3884a9f932923ae039d0d33c91dd99134deea91))
* add --verbose/-v flag for detailed runtime logging ([8083d7a](https://github.com/contentful-labs/worklog/commit/8083d7a1257011de9b1054600f98110513677641))


### Bug Fixes

* resolve all biome lint warnings ([3c65d42](https://github.com/contentful-labs/worklog/commit/3c65d42ee2235ce231cd72740d0195a1ddbd4a5a))

## [1.4.0](https://github.com/contentful-labs/worklog/compare/v1.3.0...v1.4.0) (2026-03-08)


### Features

* add --rt docx output and interactive missing week handling ([96d60d6](https://github.com/contentful-labs/worklog/commit/96d60d633a5d0bd7a92f7ac2d874611e017ce4de))
* add anti-AI-slop writing style guide to prep prompts ([241a776](https://github.com/contentful-labs/worklog/commit/241a7761c082fdb60efaa2fe93013ba86c10dfeb))
* beta distribution readiness ([130071a](https://github.com/contentful-labs/worklog/commit/130071acaa65d35248889a689800f4b57a887206))
* enforce ticket status freshness in brag book generation ([90c47c3](https://github.com/contentful-labs/worklog/commit/90c47c3fdb7dd9b900af8f1cb6e33da7bd27e853))
* prep DOCX output, humanized writing, vault cleanup ([cc6dc11](https://github.com/contentful-labs/worklog/commit/cc6dc1153ff11a07627407e1518ea9d6bf3d415c))


### Bug Fixes

* prevent ReDoS in review cycle regex ([2e5dd2c](https://github.com/contentful-labs/worklog/commit/2e5dd2c1262ed1d53585ea3d915d727825815b22))

## [1.3.0](https://github.com/contentful-labs/worklog/compare/v1.2.3...v1.3.0) (2026-03-03)


### Features

* [] proactive research tools and vault note discovery ([ec25330](https://github.com/contentful-labs/worklog/commit/ec25330eea3c3de8737e3bcea091fb24242a31dd))

## [1.2.3](https://github.com/contentful-labs/worklog/compare/v1.2.2...v1.2.3) (2026-03-02)


### Bug Fixes

* [] send input as message array for codex endpoint ([c36f16b](https://github.com/contentful-labs/worklog/commit/c36f16b3d43bd59878edab45ca51d4f3964ab613))
* [] send input as message array for codex endpoint ([be2562b](https://github.com/contentful-labs/worklog/commit/be2562b5ea62bda1960a14f0ec1baa6f71283538))

## [1.2.2](https://github.com/contentful-labs/worklog/compare/v1.2.1...v1.2.2) (2026-03-02)


### Bug Fixes

* [] use correct ChatGPT subscription endpoint ([8b3d43c](https://github.com/contentful-labs/worklog/commit/8b3d43ca486d425c669fdadd099ade6a2a7f35e1))
* [] use correct ChatGPT subscription endpoint ([d517e27](https://github.com/contentful-labs/worklog/commit/d517e27bdbd24163b63a876603cbb72d7556a4bf))

## [1.2.1](https://github.com/contentful-labs/worklog/compare/v1.2.0...v1.2.1) (2026-03-02)


### Bug Fixes

* [] use Claude Agent SDK for Max subscription support ([9a1ae5b](https://github.com/contentful-labs/worklog/commit/9a1ae5bd4f2fc640172cfd879476ad26a971eab5))
* [] use Claude Agent SDK for Max subscription support ([99801c5](https://github.com/contentful-labs/worklog/commit/99801c5c984146918b23d1242d57900989c9d5f9))

## [1.2.0](https://github.com/contentful-labs/worklog/compare/v1.1.5...v1.2.0) (2026-03-02)


### Features

* [] add Anthropic Claude as AI provider option ([d46efc1](https://github.com/contentful-labs/worklog/commit/d46efc1a623ce098e3d4b011d2eda5d385d68604))
* [] add Anthropic Claude as AI provider option ([2d9479d](https://github.com/contentful-labs/worklog/commit/2d9479d89858e76f116dc782a17090fb6e325e81))

## [1.1.5](https://github.com/contentful-labs/worklog/compare/v1.1.4...v1.1.5) (2026-03-02)


### Bug Fixes

* [] use /v1/responses not /v1/codex/responses ([744e2e9](https://github.com/contentful-labs/worklog/commit/744e2e98ac51bcdfcb5b7d4d1da92d0a47456e1e))
* use /v1/responses endpoint, refresh token before each request ([c4f7218](https://github.com/contentful-labs/worklog/commit/c4f7218f95bcb0885c535ec96ee57b6eebc13da9))

## [1.1.4](https://github.com/contentful-labs/worklog/compare/v1.1.3...v1.1.4) (2026-03-02)


### Bug Fixes

* [] use /v1/codex/responses endpoint with proper auth ([b89c578](https://github.com/contentful-labs/worklog/commit/b89c5786957022fdc3201745a38cd7d1cb1fd998))
* use /v1/codex/responses endpoint with proper headers and token refresh ([224ad7d](https://github.com/contentful-labs/worklog/commit/224ad7db456d4ebc32aded4636743e68a1a57c86))

## [1.1.3](https://github.com/contentful-labs/worklog/compare/v1.1.2...v1.1.3) (2026-03-02)


### Bug Fixes

* [] route subscription tokens to Responses API ([66711ff](https://github.com/contentful-labs/worklog/commit/66711ffedc215b5f878a4234d7dd03c3649ca400))
* route subscription tokens to Responses API with account header ([c062260](https://github.com/contentful-labs/worklog/commit/c062260d142d89c1c5c558b186e6b12949d2861f))

## [1.1.2](https://github.com/contentful-labs/worklog/compare/v1.1.1...v1.1.2) (2026-03-02)


### Bug Fixes

* [] use Chat Completions API instead of Agents SDK ([5e45e39](https://github.com/contentful-labs/worklog/commit/5e45e39c15d8866b695a02d12263999d9235c1cc))
* use Chat Completions API instead of Agents SDK ([041e5bb](https://github.com/contentful-labs/worklog/commit/041e5bbae8a10ffc93b5d12a965fe4d109415845))

## [1.1.1](https://github.com/contentful-labs/worklog/compare/v1.1.0...v1.1.1) (2026-03-02)


### Bug Fixes

* [] remove dead document parsing code from init ([e95ad48](https://github.com/contentful-labs/worklog/commit/e95ad48845c0995d882e47da8450dd09604f2967))
* remove dead document parsing code from init ([22457ca](https://github.com/contentful-labs/worklog/commit/22457cade6dac73a0322be98bf147b399fc9945e))

## [1.1.0](https://github.com/contentful-labs/worklog/compare/v1.0.1...v1.1.0) (2026-02-27)


### Features

* guide users through API token setup during init ([708144d](https://github.com/contentful-labs/worklog/commit/708144dffa64c12dfa3c40566d0751d5cce6e9b1))
* guide users through API token setup during init ([eff5f5e](https://github.com/contentful-labs/worklog/commit/eff5f5eaacf06ef3bacb904abf8e98e12eabbbb1))

## [1.0.1](https://github.com/contentful-labs/worklog/compare/v1.0.0...v1.0.1) (2026-02-27)


### Bug Fixes

* [] ensure typecheck passes ([d633058](https://github.com/contentful-labs/worklog/commit/d633058a14756add8f3247f32451bc14401488f2))
* [] guard against undefined shellTool export ([8886db7](https://github.com/contentful-labs/worklog/commit/8886db7dbb52b508db0fa9def51ece18914b3797))
* [] guard validate callbacks against undefined input ([7bad1ef](https://github.com/contentful-labs/worklog/commit/7bad1efb3b9686b131a4f120978cc3571d8794d9))
* [] harden CLI against undefined values in init and AI tools ([a054a49](https://github.com/contentful-labs/worklog/commit/a054a4959a0ad099406c31d04c0463e916622b63))

## 1.0.0 (2026-02-27)


### Features

* initial release ([8aec73e](https://github.com/contentful-labs/worklog/commit/8aec73e565a9ae7fb716b2622b90e747691f676e))


### Bug Fixes

* [] harden init default setup ([6d7d0c1](https://github.com/contentful-labs/worklog/commit/6d7d0c1c2f7c396843f53c4c736ed6d3ea8da739))
* [] Harden init defaults and recovery ([9f87767](https://github.com/contentful-labs/worklog/commit/9f8776733cfe45139ad05b7cdcb6a84e7f31f2ac))
