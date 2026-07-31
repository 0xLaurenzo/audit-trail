/**
 * Registers the shared harness behavior contract and the model-discovery
 * contract for every shipped harness, and enforces registry completeness: a
 * harness cannot ship (gain a real installer) without a capability
 * declaration and a conformance driver.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HARNESS_CAPABILITIES, SHIPPED_HARNESSES } from "../src/harness/capabilities.ts";
import { installers } from "../src/install/installers.ts";
import { registerHarnessConformance, registerModelDiscoveryConformance } from "./helpers/harness-contract.ts";
import { CONFORMANCE_DRIVERS } from "./helpers/harness-drivers.ts";

test("every shipped harness has a capability declaration and a conformance driver", () => {
	const shipped = [...SHIPPED_HARNESSES].sort();
	assert.deepEqual(Object.keys(HARNESS_CAPABILITIES).sort(), shipped, "capability registry covers shipped harnesses");
	assert.deepEqual(Object.keys(CONFORMANCE_DRIVERS).sort(), shipped, "conformance drivers cover shipped harnesses");
	for (const harness of SHIPPED_HARNESSES) {
		assert.equal(HARNESS_CAPABILITIES[harness].version, 1, `${harness} declares the current capability version`);
		assert.equal(typeof CONFORMANCE_DRIVERS[harness], "function", `${harness} supplies a driver factory`);
	}
});

test("every real installer harness is shipped, and every shipped harness has an installer", () => {
	// Planned installers are placeholders for future issues; a harness with a
	// real installer must declare capabilities and join the contract suite.
	const realInstallers = installers
		.filter((installer) => !/support ships in issue/.test(installer.description))
		.map((installer) => installer.harness)
		.sort();
	assert.deepEqual(realInstallers, [...SHIPPED_HARNESSES].sort());
});

for (const harness of SHIPPED_HARNESSES) {
	const input = {
		harness,
		capabilities: HARNESS_CAPABILITIES[harness],
		createDriver: CONFORMANCE_DRIVERS[harness],
	};
	registerHarnessConformance(input);
	registerModelDiscoveryConformance(input);
}
