import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, jsonError, httpError, setVoice } from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

export async function POST({ params, request, cookies }) {
	try {
		const { uid, room } = await requireMember(cookies, params.id);
		const { action, heal } = await request.json();
		if (action !== 'join' && action !== 'leave') throw httpError(400, 'Invalid action');

		/* Through setVoice, NOT by editing the state blob and writing it back.
		   That is what this endpoint used to do, and it made the roster collateral
		   damage of every other write: end/rematch/game-type read the blob, spend a
		   few hundred milliseconds in Odoo, and write their copy back — erasing a
		   join that landed in between, silently, at a higher version that every
		   client accepts. It cut the other way too: this route's own blob write
		   carried `game`, so joining voice mid-move could roll a move back.

		   The cap moved with it. It used to be checked here against a blob already
		   read, so two joins arriving together both passed; inside the object the
		   read and the write are one step. */
		const { state, changed, needsWrite } = await setVoice(params.id, uid, action, parseState(room));
		if (needsWrite) await writeState(params.id, state);
		/* Announce only a real join or leave.
		   `changed` drops the no-ops. `heal` drops the client re-entering a roster
		   it was dropped from without ever leaving the call — and that one is not
		   cosmetic. The object drops a uid whenever its last socket closes, which
		   on iOS is every app switch, and it appends NOTHING when it does. So an
		   announced heal would write an unpaired "joined voice" into the room's
		   log per backgrounding, archived to Odoo, for a player who never left.
		   Silence on the way out has to mean silence on the way back in. */
		if (changed && !heal) {
			await appendEvent(params.id, 'system', { kind: `voice-${action}`, uid }, uid);
		}
		return json({ ok: true, voice: state.voice, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}
