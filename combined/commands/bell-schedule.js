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

// Always use the conference schedule for start times
export function getStartTimeForPeriod({ period }) {
	return CONFERENCE_SCHEDULE[period];
}
