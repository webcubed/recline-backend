import xo from "eslint-config-xo";

export default [
	{
		rules: {
			"no-new": "off",
			"no-undef": "off",
			radix: "off",
			"sort-imports": "error",
		},
	},

	...xo,
];
