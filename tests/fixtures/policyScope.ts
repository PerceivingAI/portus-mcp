import nodeTest from "node:test";
import { createPolicySnapshot, loadPolicyConfig, runWithPolicyConfig } from "../../src/policy/policyConfig.js";
import type { PortusPolicyConfig } from "../../src/policy/policyConfig.js";

/** Model one backend lifetime, including policy-dependent fixture initialization. */
export function createPolicyTest(policy: PortusPolicyConfig = loadPolicyConfig()) {
  const snapshot = createPolicySnapshot(policy);
  const run = <T>(action: () => T): T => runWithPolicyConfig(snapshot, action);
  const test = new Proxy(nodeTest, {
    apply(target, thisArg, args: unknown[]) {
      const scopedArgs = args.map((argument) => typeof argument === "function"
        ? (...callbackArgs: unknown[]) => run(() => Reflect.apply(argument, undefined, callbackArgs))
        : argument);
      return Reflect.apply(target, thisArg, scopedArgs);
    }
  });
  return { test, run, policy: snapshot };
}
