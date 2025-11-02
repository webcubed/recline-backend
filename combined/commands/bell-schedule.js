export const SCHEDULE_TYPES = {
	REGULAR: "regular",
	CONFERENCE: "conference",
};

export const REGULAR_SCHEDULE = {
	1: "08:00:00",
	2: "08:45:00",
	3: "09:30:00",
	4: "10:20:00",
	5: "11:06:00",
	6: "11:52:00",
	7: "12:38:00",
	8: "13:24:00",
	9: "14:10:00",
	10: "14:56:00",
};

export const CONFERENCE_SCHEDULE = {
	1: "08:00:00",
	2: "08:50:00",
	3: "09:40:00",
	4: "10:30:00",
	5: "11:20:00",
	6: "12:10:00",
	7: "13:00:00",
	8: "13:50:00",
	9: "14:40:00",
	10: "15:30:00",
};

export function getStartTimeForPeriod({
	period,
	scheduleType = SCHEDULE_TYPES.REGULAR,
}) {
	const table =
		scheduleType === SCHEDULE_TYPES.CONFERENCE
			? CONFERENCE_SCHEDULE
			: REGULAR_SCHEDULE;
	return table[period];
}
