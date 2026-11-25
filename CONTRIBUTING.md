# Contributing to Open Dialer

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## How

1. Open an issue first for anything bigger than a small fix, so we agree on the approach before you build it.
2. Keep changes small and focused. Run `npx tsc --noEmit -p .` and `npm run build` before you send them.
3. Add yourself to [CONTRIBUTORS.md](CONTRIBUTORS.md) in your first pull request.

## Releasing (maintainer)

1. Set the new version in `package.json` and `installer/OpenDialer.iss` (`AppVersion`), and in the README's release
   badge (`&v=…`, so the badge refreshes right away instead of after its cache expires).
2. Commit, push `main`, then push a tag like `v0.1.3`. GitHub builds `OpenDialerSetup.exe` and attaches it to the
   release.

## Contributor agreement

Open Dialer is offered under the AGPL-3.0 (see [NOTICE.md](NOTICE.md)) and, separately, under commercial licenses
(see [COMMERCIAL.md](COMMERCIAL.md)). So that both can include your work, every pull request needs this agreement.
Saying "I agree to the contributor agreement in CONTRIBUTING.md" in your first pull request is enough.

> I wrote this contribution myself or have the right to submit it. I keep the copyright in it, and I grant
> Yoga Bayu Savira a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, copy, change and
> distribute it, and to license it to others under any terms, including the AGPL-3.0 and commercial licenses.
> I understand that my contribution and my name in CONTRIBUTORS.md are public.
