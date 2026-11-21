# Attribution

**Nubo is a fork of [Coucou](https://github.com/Louis-CFM/coucou)**, created by
**Louis Raillé** and published under the MIT License. Almost all of the code in
this repository is his; the changes of this fork are listed in the README.

- Original project: https://github.com/Louis-CFM/coucou
- Original author: Louis Raillé — © 2026, MIT License (see [LICENSE](LICENSE)).
- The phone link (`src-tauri/src/phone_link/` and the test vectors in `relay/`)
  is by **Rhytam Biswas** — © 2026, MIT License
  (see [THIRD_PARTY/phone-link-LICENSE.txt](THIRD_PARTY/phone-link-LICENSE.txt)).
- The translations of the interface that come from the original app
  (`src/i18n/strings.json`) were generated from its catalog.

## What is not here, and why

The original's [LICENSE-ASSETS.md](https://github.com/Louis-CFM/coucou/blob/main/LICENSE-ASSETS.md)
keeps its **name "Coucou", the name and character "Mochi", the app icon, the
sounds and the images** for its author, and does not allow distributing a
derivative under them. So this repository **does not include** them:

- the app icon is this fork's own (`src-tauri/icons/`);
- the sounds are not included — put your own `.wav` files in `sounds/`
  (see [sounds/README.md](sounds/README.md)); without them the app is silent;
- the screenshots of the original are not included.

This project is **not made, endorsed or supported by Louis Raillé**. Please do
not ask him about problems of Nubo: open an issue here.
