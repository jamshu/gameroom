// One-time (idempotent, re-runnable) Odoo provisioning for Gamerooms.
// Creates the manual models/fields, read-only access for internal users, full
// access for the settings (admin) group, and locks x_gameroom.x_studio_state
// to the admin group at the FIELD level — it holds thief-finder secret roles,
// so a player hitting Odoo JSON-RPC directly must never be able to read it.
//
// Works on Odoo 19+ (unified ir.access) and 17/18 (ir.model.access).
//
// Run: npm run setup:odoo   (reads .env via node --env-file)

const URL_ = (process.env.ODOO_URL || '').replace(/\/$/, '');
const DB = process.env.ODOO_DB;
const USER = process.env.ODOO_USERNAME;
const KEY = process.env.ODOO_API_KEY;
if (!URL_ || !DB || !USER || !KEY) {
	console.error('Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY in .env');
	process.exit(1);
}

async function service(serviceName, method, args) {
	const res = await fetch(`${URL_}/jsonrpc`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'call',
			params: { service: serviceName, method, args },
			id: Date.now()
		})
	});
	const data = await res.json();
	if (data.error) throw new Error(data.error.data?.message || data.error.message || 'Odoo error');
	return data.result;
}

let uid;
async function x(model, method, args = [], kwargs = {}) {
	return service('object', 'execute_kw', [DB, uid, KEY, model, method, args, kwargs]);
}

async function ensureModel(model, name) {
	const found = await x('ir.model', 'search', [[['model', '=', model]]]);
	if (found.length) return found[0];
	const id = await x('ir.model', 'create', [{ name, model, state: 'manual' }]);
	console.log(`  + model ${model}`);
	return id;
}

// vals: { name, ttype, relation?, selection?, groupIds? }
//   selection is [[value, label], ...] for ttype:'selection'
//   groupIds restricts the field to those res.groups (secrecy mechanism)
async function ensureField(modelId, model, vals) {
	const found = await x('ir.model.fields', 'search', [
		[['model_id', '=', modelId], ['name', '=', vals.name]]
	]);
	if (found.length) {
		// leave existing field/selection values as-is, but enforce on_delete so a
		// re-run patches already-provisioned FKs (default 'set null' → orphans).
		if (vals.on_delete) {
			const [cur] = await x('ir.model.fields', 'read', [found, ['on_delete']]);
			if (cur.on_delete !== vals.on_delete) {
				await x('ir.model.fields', 'write', [found, { on_delete: vals.on_delete }]);
				console.log(`  ~ field ${model}.${vals.name} on_delete → ${vals.on_delete}`);
			}
		}
		return found[0];
	}
	const { selection, groupIds, ...rest } = vals;
	const create = {
		model_id: modelId,
		state: 'manual',
		field_description: vals.name.replace(/^x_studio_/, '').replace(/_/g, ' '),
		...rest
	};
	if (vals.ttype === 'selection' && selection) {
		create.selection_ids = selection.map(([value, name], i) => [
			0, 0, { value, name, sequence: (i + 1) * 10 }
		]);
	}
	if (groupIds?.length) create.groups = [[6, 0, groupIds]];
	const id = await x('ir.model.fields', 'create', [create]);
	console.log(`  + field ${model}.${vals.name} (${vals.ttype})`);
	return id;
}

async function groupIdByXmlId(module, name) {
	const rows = await x('ir.model.data', 'search_read', [
		[['module', '=', module], ['name', '=', name], ['model', '=', 'res.groups']],
		['res_id']
	]);
	return rows[0]?.res_id || null;
}

// Odoo 19+ has the unified ir.access model; 17/18 use ir.model.access.
let hasIrAccess = null;
async function detectAccessModel() {
	if (hasIrAccess == null) {
		const found = await x('ir.model', 'search', [[['model', '=', 'ir.access']]]);
		hasIrAccess = found.length > 0;
		console.log(`  access model: ${hasIrAccess ? 'ir.access (Odoo 19+)' : 'ir.model.access'}`);
	}
	return hasIrAccess;
}

async function ensureAdminAccess(modelId, model, groupId) {
	if (await detectAccessModel()) {
		const found = await x('ir.access', 'search', [
			[['model_id', '=', modelId], ['group_id', '=', groupId]]
		]);
		if (found.length) return found[0];
		const id = await x('ir.access', 'create', [{
			name: `${model} admin access`,
			model_id: modelId,
			group_id: groupId,
			operation: 'crud'
		}]);
		console.log(`  + access ${model} (admin crud)`);
		return id;
	}
	const found = await x('ir.model.access', 'search', [
		[['model_id', '=', modelId], ['group_id', '=', groupId]]
	]);
	if (found.length) return found[0];
	const id = await x('ir.model.access', 'create', [{
		name: `${model} admin access`,
		model_id: modelId,
		group_id: groupId,
		perm_read: true,
		perm_write: true,
		perm_create: true,
		perm_unlink: true
	}]);
	console.log(`  + access ${model} (admin crud)`);
	return id;
}

// Players must have NO direct Odoo access at all — the proxy (admin key) is the
// only data path. Odoo 19 does not enforce field-level `groups` on direct RPC
// reads of manual fields, so a read grant would leak thief-finder secret roles.
async function removeAccess(modelId, model, groupId) {
	const accessModel = (await detectAccessModel()) ? 'ir.access' : 'ir.model.access';
	const found = await x(accessModel, 'search', [
		[['model_id', '=', modelId], ['group_id', '=', groupId]]
	]);
	if (found.length) {
		await x(accessModel, 'unlink', [found]);
		console.log(`  - removed ${model} access for internal users`);
	}
}

async function main() {
	uid = await service('common', 'login', [DB, USER, KEY]);
	if (!uid) throw new Error('Admin login failed — check ODOO_USERNAME / ODOO_API_KEY');
	console.log(`Logged in as uid ${uid} on ${URL_} (${DB})`);

	const adminGid = await groupIdByXmlId('base', 'group_system');
	const internalGid = await groupIdByXmlId('base', 'group_user');
	if (!adminGid || !internalGid) throw new Error('base groups not found');

	/* ------------------------------- models -------------------------------- */
	console.log('Models & fields:');
	const roomModel = await ensureModel('x_gameroom', 'Game Room');
	for (const f of [
		{ name: 'x_studio_game_type', ttype: 'selection', selection: [['chess', 'Chess'], ['carroms', 'Carroms'], ['thief_finder', 'Thief Finder']] },
		{ name: 'x_studio_status', ttype: 'selection', selection: [['lobby', 'Lobby'], ['playing', 'Playing'], ['finished', 'Finished']] },
		{ name: 'x_studio_host_id', ttype: 'many2one', relation: 'res.users' },
		{ name: 'x_studio_max_players', ttype: 'integer' },
		{ name: 'x_studio_draws_total', ttype: 'integer' },
		// SECRET-BEARING: thief-finder roles live in this JSON. Field-level group
		// restriction means internal users can't read it even with direct RPC.
		{ name: 'x_studio_state', ttype: 'text', groupIds: [adminGid] }
	]) await ensureField(roomModel, 'x_gameroom', f);

	const memberModel = await ensureModel('x_room_member', 'Room Member');
	for (const f of [
		{ name: 'x_studio_room_id', ttype: 'many2one', relation: 'x_gameroom', on_delete: 'cascade' },
		{ name: 'x_studio_user_id', ttype: 'many2one', relation: 'res.users' },
		{ name: 'x_studio_status', ttype: 'selection', selection: [['pending', 'Pending'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['left', 'Left']] },
		{ name: 'x_studio_role', ttype: 'selection', selection: [['player', 'Player'], ['spectator', 'Spectator']] },
		{ name: 'x_studio_score', ttype: 'integer' },
		{ name: 'x_studio_last_seen', ttype: 'datetime' }
	]) await ensureField(memberModel, 'x_room_member', f);

	const eventModel = await ensureModel('x_room_event', 'Room Event');
	for (const f of [
		{ name: 'x_studio_room_id', ttype: 'many2one', relation: 'x_gameroom', on_delete: 'cascade' },
		{ name: 'x_studio_type', ttype: 'char' },
		{ name: 'x_studio_payload', ttype: 'text' },
		{ name: 'x_studio_sender_uid', ttype: 'integer' },
		{ name: 'x_studio_target_uid', ttype: 'integer' }
	]) await ensureField(eventModel, 'x_room_event', f);

	/* --------------------------- access rights ----------------------------- */
	// Players (internal users): NO direct access. All reads AND writes go
	// through the app proxy with the admin key after app-level authorization.
	console.log('Access rights:');
	for (const [mid, m] of [[roomModel, 'x_gameroom'], [memberModel, 'x_room_member'], [eventModel, 'x_room_event']]) {
		await removeAccess(mid, m, internalGid);
		await ensureAdminAccess(mid, m, adminGid);
	}

	console.log('Done.');
}

main().catch((e) => {
	console.error('FAILED:', e.message);
	process.exit(1);
});
