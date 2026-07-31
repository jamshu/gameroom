// The rules moved to ../shared/gamelogic.js so the Durable Object can run them
// too — the DO is bundled outside the SvelteKit build, where `$env` (which this
// module used to reach via room.js → odoo.js) does not resolve.
//
// This re-export exists so the ~19 modules importing `$lib/server/gamelogic.js`
// — every game route, poll/+server.js, and the check scripts — need no change.
export * from '../shared/gamelogic.js';
