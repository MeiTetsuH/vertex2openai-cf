# Personal deployment maintenance

This public repository is the Git source for the existing personal Cloudflare deployment. It follows `workHMZ/vertex2openai-cf`; the Cloudflare Git integration watches this repository's `main`, not the workHMZ repository. Do not add credentials, local `.dev.vars` contents, account identifiers, or personal environment values to this document.

## Baseline and retained differences

Before this document was added, both repositories' `main` pointed to `21649610ff49898b5853855d6a410f1d1874b934` on 2026-10-24, with identical tracked trees. There was no separate personal application-code patch to restore. This document is an intentional deployment-fork-only addition. Production secrets and service settings live outside Git; their values must not be copied into the public source.

Keep `.nvmrc` (Node 24.22.1), the patched runtime engine requirement, `package.json`, and `package-lock.json` in sync with the verified shared source. Preserve the existing configuration and secret bindings; a source-tree comparison alone does not validate them.

## Undici patch and npm 10 compatibility

`package.json` uses the global override `"undici": "^7.30.1"`; `package-lock.json` resolves 7.30.1. This patches [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) in the Miniflare development chain. The Worker application has no runtime npm dependencies, so this finding is not evidence of an exploit through its production API.

The original scoped form, `"miniflare": { "undici": "^7.30.1" }`, passed the local toolchain but failed Cloudflare's npm 10.9.2 clean install with `Missing: undici@7.29.1 from lock file`. An isolated npm 10.9.2 `ci --dry-run --ignore-scripts --no-audit --no-fund` reproduced the failure. The equivalent global override passed the same check with the lockfile byte-for-byte unchanged; the repository verify gate and final cloud build then passed.

Do not restore the scoped form merely to minimize the manifest diff, downgrade Undici to 7.29.1, or regenerate a broad set of dependencies. Retain the global override until the upstream toolchain both resolves a patched compatible Undici and passes a frozen clean install using the actual Cloudflare npm version. If a future dependency adds another Undici major, review that caller before retaining a global constraint across incompatible majors.

## Future synchronization and release

1. Fetch both repositories and inspect their actual default branches and the personal-fork diff. Merge the verified workHMZ commit normally; retain this document and any later intentional personal changes. Do not reset the fork or use `merge=ours`/`assume-unchanged`.
2. Inspect `package.json` and `package-lock.json` together. Use npm only, run `npm audit`, validate clean installation with the deployment npm version, and run `npm run verify`. The npm 10 dry-run above checks lock compatibility only; it does not replace installation, tests, or a cloud build.
3. Confirm the existing Worker target, nonsecret variables, binding names/types, and deployment command before pushing `main`. Preserve existing secrets; never print their values. The current Git deployment command is `npx wrangler deploy`, so compare the repository's plain variables with the live settings before publication rather than assuming `--keep-vars` is present.
4. Push the verified source to this personal repository's `main` and wait for the existing automatic deployment. Do not issue a second manual deploy for the same push.
5. Verify the active production version, the public health response, and authentication on `/v1/models`. A successful models response does not validate paid inference, streaming, or every provider credential path; run billable end-to-end checks only when separately intended.

Keep workflow completion, the active Cloudflare version, and live API evidence separate. A failed build before deployment must not be described as a new production version.
