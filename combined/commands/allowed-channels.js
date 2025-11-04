// Central mapping of allowed channels and their permitted sections
// Also exposes helpers to validate a channel/section and role permissions.

export const ROLE_HOMEWORK_MONITOR = "1424082174658744350"; // String for safety

export const CHANNELS = {
	CHAN: "1425641686242951210",
	HUA: "1425641754673152082",
	MAGGIO: "1425653561987170375",
	TEST: "1430710931049939027",
};

// Sections mapping (1..7) based on existing section->classKey mapping in commands
export const TEACHER_SECTIONS = {
	CHAN: [5, 7],
	HUA: [3, 6],
	MAGGIO: [1, 2, 4],
};

export function allowedSectionsForChannel(channelId) {
	if (channelId === CHANNELS.TEST) return [1, 2, 3, 4, 5, 6, 7];
	if (channelId === CHANNELS.CHAN) return TEACHER_SECTIONS.CHAN;
	if (channelId === CHANNELS.HUA) return TEACHER_SECTIONS.HUA;
	if (channelId === CHANNELS.MAGGIO) return TEACHER_SECTIONS.MAGGIO;
	return [];
}

export function isChannelAllowed(channelId) {
	return allowedSectionsForChannel(channelId).length > 0;
}

export function hasMonitorRole(member) {
	try {
		return member?.roles?.cache?.has?.(ROLE_HOMEWORK_MONITOR) ?? false;
	} catch {
		return false;
	}
}
