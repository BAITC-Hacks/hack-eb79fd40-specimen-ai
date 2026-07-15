# Demeu local runtime fonts

The same repository TTF sources are bundled by Next.js for the web UI and read
from `assets/fonts/` by the server-side PDF renderer. Build and runtime do not
request Google Fonts or another font CDN.

Official upstream: `google/fonts` at commit
`01848217e069afd63f72175b9b075ad9e07b8df8` (2026-07-15 checkout).

| Repository file | Exact upstream source | SHA-256 | Use |
|---|---|---|---|
| `Lora-Variable.ttf` | `https://raw.githubusercontent.com/google/fonts/01848217e069afd63f72175b9b075ad9e07b8df8/ofl/lora/Lora%5Bwght%5D.ttf` | `822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7` | Web headings/assistant voice and PDF title/hypothesis; weight 400–700 |
| `Lora-Italic-Variable.ttf` | `https://raw.githubusercontent.com/google/fonts/01848217e069afd63f72175b9b075ad9e07b8df8/ofl/lora/Lora-Italic%5Bwght%5D.ttf` | `22d8d8854b53807aa664ca34f2031a9ed57a1d0dea296b8b96cdd3aad937a2b3` | Web italic design accents; weight 400–700 |
| `IBMPlexSans-Variable.ttf` | `https://raw.githubusercontent.com/google/fonts/01848217e069afd63f72175b9b075ad9e07b8df8/ofl/ibmplexsans/IBMPlexSans%5Bwdth%2Cwght%5D.ttf` | `3b031aa4216174205bd8471f88a49b91f093169e9e87bd5262242bc5967fe2e3` | Web UI/data and PDF body/data; width 75–100, weight 100–700 |

All three files include Russian and Kazakh Cyrillic. Lora is licensed under the
SIL Open Font License 1.1 in `LICENSE-Lora-OFL.txt`; IBM Plex Sans is licensed
under the SIL Open Font License 1.1 in `LICENSE-IBM-Plex-Sans-OFL.txt`. The
license files were copied from the same pinned upstream commit.
