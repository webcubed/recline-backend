/* eslint-disable sort-imports */
/*
	Quick mock runner to test homework renderers outside Discord.
*/
import { writeFileSync } from "node:fs";
import { renderEmbed, renderImage, renderText } from "./homework-renderers.js";

const events = [
	{
		title: "Read Chapter 5",
		classKey: "chan 9/10",
		dueTimestamp: Date.now() + 36 * 3600 * 1000,
	},
	{
		title: "Worksheet #3",
		classKey: "chan 9/10",
		dueTimestamp: Date.now() + 72 * 3600 * 1000,
	},
	{
		title: "Essay draft",
		classKey: "hua 5/6",
		dueTimestamp: Date.now() + 96 * 3600 * 1000,
	},
];

const headerClass = "chan 9/10";

console.log("text\n================");
console.log(renderText({ events, headerClass }));

console.log("\nembed (JSON)\n====================");
console.log(JSON.stringify(renderEmbed({ events, headerClass }), null, 2));

console.log("\nimage\n=============");
const imageResult = await renderImage({ events, headerClass });
if (imageResult.files?.[0]) {
	const file = imageResult.files[0];
	const name = file.name ?? "homework.bin";
	writeFileSync(name, file.attachment);
	console.log(`wrote ${name}`);
} else {
	console.log("uh oh no image");
}
