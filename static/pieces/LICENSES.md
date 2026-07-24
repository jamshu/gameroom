# Chess piece set licences

Each subdirectory is one selectable piece set. Attribution is required for the
third-party sets below — keep this file with the artwork.

| Set | Author | Licence |
|---|---|---|
| `polished/` | This project (hand-polished in-house) | Project's own artwork |
| `chessnut/` | [Alexis Luengas](https://github.com/LexLuengas/chessnut-pieces) | [Apache 2.0](https://github.com/LexLuengas/chessnut-pieces/blob/master/LICENSE.txt) |
| `fantasy/` | [Maurizio Monge](https://github.com/maurimo/chess-art) | [MIT](https://github.com/maurimo/chess-art/blob/main/LICENSE) |

Both third-party sets are permissively licensed and safe for commercial use as
long as this attribution ships with them. They were obtained from the
[lichess-org/lila](https://github.com/lichess-org/lila) asset tree.

## Deliberately NOT bundled

Several attractive Lichess sets (maestro, fresca, cardinal, tatiana, gioco,
staunty, dubrovny, california, caliente, anarcandy) are **CC BY-NC-SA** —
non-commercial only. Do not add them unless this project is certain to stay
non-commercial. `cburnett` and `merida` are GPLv2+ (copyleft), which can oblige
derived work to carry the same licence.

Chess.com's own piece sets (Neo and friends) are proprietary and must not be
copied into this repo.

## Adding a set

1. Drop 12 SVGs named `wK wQ wR wB wN wP bK bQ bR bB bN bP` into
   `static/pieces/<set-id>/`.
2. Add the set to `PIECE_SETS` in `src/lib/chessthemes.svelte.js`.
3. Record its author and licence in the table above.
