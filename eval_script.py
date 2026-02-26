import json
import os
import sys
from jsonschema import validate, ValidationError

# Schema that each eval scenario file must match
SCENARIO_SCHEMA = {
    "type": "object",
    "properties": {
        "description": {"type": "string"},
        "request": {"type": "string"},
        "expected_outcome": {"type": "string"},
        "constraints": {"type": "object"},
    },
    "required": ["description", "request", "expected_outcome", "constraints"],
}

# Schema for an API edit-plan response (used for reference validation)
EDIT_PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "editPlan": {
            "type": "object",
            "properties": {
                "timelineOps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "op": {"type": "string"},
                            "args": {"type": "object"},
                        },
                        "required": ["op", "args"],
                    },
                }
            },
            "required": ["timelineOps"],
        }
    },
    "required": ["editPlan"],
}


def validate_range(value, min_val, max_val):
    return min_val <= value <= max_val


def validate_no_overlap(markers):
    for i in range(len(markers)):
        for j in range(i + 1, len(markers)):
            if (
                markers[i]["in"] <= markers[j]["in"] <= markers[i]["out"]
                or markers[j]["in"] <= markers[i]["in"] <= markers[j]["out"]
            ):
                return False
    return True


def validate_min_max_length(text, min_len, max_len):
    return min_len <= len(text) <= max_len


def validate_sorted(markers):
    times = [marker["in"] for marker in markers]
    return times == sorted(times)


def run_evaluations():
    scenario_dir = "docs/ai/eval_scenarios"

    if not os.path.isdir(scenario_dir):
        print(f"Scenario directory '{scenario_dir}' not found.")
        return 1

    scenario_files = sorted(f for f in os.listdir(scenario_dir) if f.endswith(".json"))

    total_scenarios = len(scenario_files)
    passed_scenarios = 0
    failed_scenarios = 0

    print(f"Running evaluation on {total_scenarios} scenarios...")

    for scenario_file in scenario_files:
        print(f"\nProcessing {scenario_file}...")

        filepath = os.path.join(scenario_dir, scenario_file)
        try:
            with open(filepath, "r") as f:
                scenario = json.load(f)
        except json.JSONDecodeError as e:
            print(f"  FAIL: Invalid JSON - {e}")
            failed_scenarios += 1
            continue

        # Validate scenario against schema
        try:
            validate(instance=scenario, schema=SCENARIO_SCHEMA)
            print("  Schema validation passed.")
        except ValidationError as e:
            print(f"  FAIL: Schema validation - {e.message}")
            failed_scenarios += 1
            continue

        # Validate constraint values are well-formed
        constraints = scenario.get("constraints", {})
        constraint_ok = True

        for key, val in constraints.items():
            if isinstance(val, dict):
                # Range constraints (min/max)
                if "min" in val and "max" in val:
                    if val["min"] > val["max"]:
                        print(f"  FAIL: Constraint '{key}' has min > max")
                        constraint_ok = False
                # Length constraints (min_length/max_length)
                if "min_length" in val and "max_length" in val:
                    if val["min_length"] > val["max_length"]:
                        print(f"  FAIL: Constraint '{key}' has min_length > max_length")
                        constraint_ok = False

        if constraint_ok:
            print("  Constraints validation passed.")
            passed_scenarios += 1
        else:
            failed_scenarios += 1

    print(f"\nEvaluation complete. Passed: {passed_scenarios}/{total_scenarios}, Failed: {failed_scenarios}")

    return 0 if failed_scenarios == 0 else 1


if __name__ == "__main__":
    sys.exit(run_evaluations())
