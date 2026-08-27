# Changelog

## [3.0.0](https://github.com/contentful-labs/worklog/compare/v2.0.2...v3.0.0) (2026-08-27)


### ⚠ BREAKING CHANGES

* parseBragBookResult is gone from the SDK, along with the HTML-comment markers it looked for. It scraped a markdown document for MEMORY_UPDATE, FOCUS_UPDATE and CONTEXT_UPDATES blocks, which is no longer how the weekly generation works. Use aiQueryStructured with bragBookOutputSchema to get the result, then toBragBookResult to adapt it. BragBookResult itself is unchanged, so anything consuming that type keeps working.

### Features

* constrain weekly generation to a schema instead of scraping markdown ([c55aba8](https://github.com/contentful-labs/worklog/commit/c55aba889628db2bac2b259b30a01d53e3a3b29e))
* give vault records an identity so writers stop duplicating ([27e49cf](https://github.com/contentful-labs/worklog/commit/27e49cf63608c15da993be6d12a79971e2b751ad))


### Bug Fixes

* a focus item is restated only when it is re-raised word for word ([6ddd244](https://github.com/contentful-labs/worklog/commit/6ddd24466a0a22aace7dd0be6dc6eb570b2ed38d))
* a record is every cell except the one that carries evidence ([17a20c3](https://github.com/contentful-labs/worklog/commit/17a20c34bebfd7f4c07f5a41f38856e4d92e1556))
* accept an annotated heading, and keep the impact status lines honest ([c80eb2a](https://github.com/contentful-labs/worklog/commit/c80eb2a698d3b5b4b54bde559df3d3aa95eb0d0f))
* bound the writers to the live section and stop discarding evidence ([b112dd3](https://github.com/contentful-labs/worklog/commit/b112dd30d983c23a4743cb8f86f4fd7105b43784))
* carry a duplicate's own text across a fold, and split rows dated by month ([890f821](https://github.com/contentful-labs/worklog/commit/890f82194c567863b4d857bcfa789d88f826ec8c))
* count an impact write only when one happened ([97e3378](https://github.com/contentful-labs/worklog/commit/97e3378ddbe0ad1bdc831cf5425899cc62a9fe35))
* decide what is already in a vault file by exact text ([436e67d](https://github.com/contentful-labs/worklog/commit/436e67d307c93bee2721ac44e6bd2e07447085bb))
* decode table-cell escapes in graduation targets ([25c1f9b](https://github.com/contentful-labs/worklog/commit/25c1f9b0cc604e7c092bcef87d4e7767ff23c1a6))
* derive the impact status lines on every run, not only when rows move ([2974b6f](https://github.com/contentful-labs/worklog/commit/2974b6f5f511022015bf9776fc93465e79861a4d))
* do not assume the impact log is already there ([101108d](https://github.com/contentful-labs/worklog/commit/101108dde44855889433301747268fc4777c2388))
* hold the migration to the same section bounds as the writers ([232811c](https://github.com/contentful-labs/worklog/commit/232811c66d04f87414fb69c206579992099aad7c))
* hold the work log until the week's result is validated ([127c62a](https://github.com/contentful-labs/worklog/commit/127c62a9962c4c4f5a7752755e546ce84fca6eed))
* identity is a tuple of cells, and a seeded hint is not part of a note ([4d7e3af](https://github.com/contentful-labs/worklog/commit/4d7e3af9cb0972f73cd7392efe5471663e06901b))
* ignore nested HTML as content, and write both documents atomically ([ffd6d98](https://github.com/contentful-labs/worklog/commit/ffd6d98f3f57058422814cfe46db6a53a7a1b5f4))
* keep case out of the delete test, and make a date be a date ([57f5350](https://github.com/contentful-labs/worklog/commit/57f5350c5f63a04736604073401a0928c8765b6f))
* keep case out of the focus migration's collapse too ([44ac46f](https://github.com/contentful-labs/worklog/commit/44ac46f32e4b6cc009b27f10dbcc947823809d2f))
* keep case out of the last two paths that delete ([80a8034](https://github.com/contentful-labs/worklog/commit/80a8034f5389b1f6d1f1b0c8767ac4ef06c29b16))
* keep each date of a recurring memory item, and read lazy continuations ([e163de5](https://github.com/contentful-labs/worklog/commit/e163de53876d8960d45ebf92cc1339ff534ce051))
* keep versions and language names out of the similarity flattener ([ac0c477](https://github.com/contentful-labs/worklog/commit/ac0c4771ff823e3b9aa87e68f9c010895a2d86c9))
* make similarity see negation and add a lossless canonical form ([cd63589](https://github.com/contentful-labs/worklog/commit/cd63589e280721c8bb0fd922f93c1f2b4fbd6da4))
* make the migration lossless, and never overwrite its backup ([59572b0](https://github.com/contentful-labs/worklog/commit/59572b09ea58eea8647b6f2c29297590ee57bc5e))
* match a graduation on the whole item text ([ff1d308](https://github.com/contentful-labs/worklog/commit/ff1d3087f5ea4cdc464d7465e08cbd0b42486fd7))
* never let a write reach outside the section it belongs to ([5c1bf6c](https://github.com/contentful-labs/worklog/commit/5c1bf6c029faabb05f8ff3733bdce7a30a336127))
* only touch the table this code owns, and escape a cell once ([66081a5](https://github.com/contentful-labs/worklog/commit/66081a5d75a8d9991217840744ba383691890159))
* parse headings once, and match a sentinel as a whole phrase ([1b20c06](https://github.com/contentful-labs/worklog/commit/1b20c068362815bb43d4a941d0d1bc9ca0970d1d))
* parse the brag book with remark instead of scanning for headings ([5e5dd4d](https://github.com/contentful-labs/worklog/commit/5e5dd4d22b80d7a9a129f618f21e16b3aa08aa14))
* pick the OpenAI default model from the resolved auth source ([b8a20be](https://github.com/contentful-labs/worklog/commit/b8a20be9a1bda56aae771e6d576d0f552fd8de56))
* raise the insert dedupe threshold to 0.85 for prose records ([645c3b1](https://github.com/contentful-labs/worklog/commit/645c3b1c6b3cabc83453f267e826616bb6b107c4))
* read a bullet as the whole item, and skip frontmatter ([ca9a091](https://github.com/contentful-labs/worklog/commit/ca9a09163a54867725286bc3c496e7a9512827b7))
* read a contracted negation as a negation ([8b93121](https://github.com/contentful-labs/worklog/commit/8b931215022e67019885d1b46e158c56fbe8a939))
* read a note's identity from the shape this code actually writes ([584ed4e](https://github.com/contentful-labs/worklog/commit/584ed4e5903ba47befaaa6b0b419c05c3e73740f))
* read fenced code as code, and recognise every thematic break ([98fb186](https://github.com/contentful-labs/worklog/commit/98fb186214d40007fcfe192055bfa001b2e99663))
* recover the impact entries 1.x wrote into a single row ([d1f1194](https://github.com/contentful-labs/worklog/commit/d1f1194093287b2529d01e861bc043de4e24fbdc))
* recover the impact entries 1.x wrote into a single row ([dc3bb3e](https://github.com/contentful-labs/worklog/commit/dc3bb3ef88c384d29c6a1130851250d26bc00f80))
* reject an empty achievements section, and leave a step for the object ([e41ad47](https://github.com/contentful-labs/worklog/commit/e41ad47e017486660f693e416ab2c12d1dc3b29f))
* report per-record counts in the run summary ([26b1955](https://github.com/contentful-labs/worklog/commit/26b19559995ef88e8a69741d40fdb9cdb25ecd66))
* report the updates that happened, not the ones that were asked for ([aaed23b](https://github.com/contentful-labs/worklog/commit/aaed23b4f56141188a4d0be03d0fc08244dcdecb))
* require a row's own text before deleting it, and keep the rest of the row ([beec8ab](https://github.com/contentful-labs/worklog/commit/beec8ab6a8a6872e48b88d7afcd299fa4eed9fea))
* send only the item as the graduation target ([f32da2b](https://github.com/contentful-labs/worklog/commit/f32da2b39fc9bace363340ad5dbebbebeadde3e7))
* split a cell where its values actually end, and keep the gap honest ([b019605](https://github.com/contentful-labs/worklog/commit/b019605d968a3aa0ac4a347bbc76d821ae5a76c5))
* split a row only when the file shows the inserts it lost ([62d771a](https://github.com/contentful-labs/worklog/commit/62d771a212f517bffa611b294c18c06c399e54b6))
* split the row the lost inserts point at, and carry each value once ([3ead569](https://github.com/contentful-labs/worklog/commit/3ead569938545e680e4ce5f7e00735a33a5d6e35))
* stop losing evidence to duplicates and stop writing outside the section ([cecc151](https://github.com/contentful-labs/worklog/commit/cecc151205d0bbce13e8c30115cf4b590cd521e7))
* stop rejecting pipes the vault writers already handle ([7d92c92](https://github.com/contentful-labs/worklog/commit/7d92c92911528ccacee080f6e6cef27e892d6a57))
* stop treating every hyphenated word as an identifier ([9b64b8f](https://github.com/contentful-labs/worklog/commit/9b64b8f70a0d1856212f9a240ad72b83f8cb5cf3))
* tell the user which graduations did not happen ([cab04b1](https://github.com/contentful-labs/worklog/commit/cab04b13cd23a0846319ebe9f7a85448e7c13b4a))
* the focus migration collapses repeats, not rewordings ([0b0d092](https://github.com/contentful-labs/worklog/commit/0b0d092cb725830238c710ac81bf71eb1d141808))
* validate every field before it reaches a vault file ([78db1f9](https://github.com/contentful-labs/worklog/commit/78db1f9640384f3162d8f5a0c6ad30fe7ca4baf9))
* warn when any vault update has nowhere to go ([997c6d5](https://github.com/contentful-labs/worklog/commit/997c6d5bb2f3777f9888796cc6e0f9c9e619ef16))
* warn when the impact entry has nowhere to go ([05e7c75](https://github.com/contentful-labs/worklog/commit/05e7c75a55eb869402f8084fd948eb8319cb12ce))

## [2.0.2](https://github.com/contentful-labs/worklog/compare/v2.0.1...v2.0.2) (2026-08-26)


### Bug Fixes

* ask for the Atlassian instance and GitHub orgs during init ([974c061](https://github.com/contentful-labs/worklog/commit/974c0617265abfde9e82c2f36b9f1c3e3718f2e3))
* canonicalize the Atlassian URL before saving it ([f4d62ca](https://github.com/contentful-labs/worklog/commit/f4d62ca1b419e001ba2cd23ff7d4e651da559033))
* hygiene bundle (loud supplementary fetches, account-id comments, drop perf-data, neutral init defaults) ([4cccfb6](https://github.com/contentful-labs/worklog/commit/4cccfb6a4482dc85b4b766600632eef4a36695c3))
* keep a review when its comment count cannot be fetched ([90dfd08](https://github.com/contentful-labs/worklog/commit/90dfd0874605ae68348d13e0eb091fe4dc6d0e29))
* keep generateMarkdown's accountId optional ([86e27a2](https://github.com/contentful-labs/worklog/commit/86e27a2e30c0488ce8b88bc2eb65e3ab62e43dd5))
* match your Jira comments on account id ([cc9c598](https://github.com/contentful-labs/worklog/commit/cc9c598c1d8df98cf475e702480ea39cf894bd8f))
* report per-PR review fetch failures ([bc0b8b4](https://github.com/contentful-labs/worklog/commit/bc0b8b4f2c04e5b629d0676b39f8fab5959bb74e))
* report supplementary fetch failures instead of swallowing them ([f896c0a](https://github.com/contentful-labs/worklog/commit/f896c0a6b77e98b8af193b889d8cc9467c35601a))
* use neutral placeholders in init instead of one company's setup ([323e8f4](https://github.com/contentful-labs/worklog/commit/323e8f431e259c9ae4073f332a5449c996e8de32))

## [2.0.1](https://github.com/contentful-labs/worklog/compare/v2.0.0...v2.0.1) (2026-08-26)


### Bug Fixes

* ongoing focus items stay open ([a713bb6](https://github.com/contentful-labs/worklog/commit/a713bb617bd2cbd062f68e24fb4af7c2655373d8))

## [2.0.0](https://github.com/contentful-labs/worklog/compare/v1.6.1...v2.0.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* updateFocusTracking takes an options object, getPendingFocusItems and expireStaleFocusItems are removed, and BragBookResult.focusUpdates is keyed by id instead of week plus item text.

### Features

* provider-neutral tools, focus-tracking rebuild, prompt-size guards ([71acbe3](https://github.com/contentful-labs/worklog/commit/71acbe3356a9460235ecf3668b2cbf9b7476ae05))


### Bug Fixes

* limit CI workflow token permissions ([4d3cf29](https://github.com/contentful-labs/worklog/commit/4d3cf29297e6aa387b2277abe06e8e0734808870))
* limit CI workflow token permissions ([b377479](https://github.com/contentful-labs/worklog/commit/b3774798843d61ea7a44817cddcdf595f7afe06e))
* store config paths relative to home ([301952d](https://github.com/contentful-labs/worklog/commit/301952dfeae1c5aa676b87ce54fb3e6c99b0efd7))

## [1.6.1](https://github.com/contentful-labs/worklog/compare/v1.6.0...v1.6.1) (2026-03-30)


### Bug Fixes

* add missing command name to makeWorklogCommand ([537f156](https://github.com/contentful-labs/worklog/commit/537f156ecdab08899c73da79c6116b9c960456ef))
* add missing command name to makeWorklogCommand ([2c6e2bd](https://github.com/contentful-labs/worklog/commit/2c6e2bdb4865d418e14abba7ba2bf6d1540cb9e2))

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
