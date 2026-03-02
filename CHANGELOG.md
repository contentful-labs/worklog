# Changelog

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
