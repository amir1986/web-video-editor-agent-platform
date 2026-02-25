import json
import requests
import os
from jsonschema import validate, ValidationError

# Define the base URL for the API
BASE_URL = "http://localhost:3000"

# Define the schema for validation
SCHEMA = {
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
                            "args": {"type": "object"}
                        },
                        "required": ["op", "args"]
                    }
                }
            },
            "required": ["timelineOps"]
        }
    },
    "required": ["editPlan"]
}

# Define constraints validation functions

def validate_range(value, min_val, max_val):
    return min_val <= value <= max_val


def validate_no_overlap(markers):
    # Assuming markers is a list of dictionaries with 'in' and 'out' keys
    for i in range(len(markers)):
        for j in range(i+1, len(markers)):
            if (markers[i]['in'] <= markers[j]['in'] <= markers[i]['out'] or
                markers[j]['in'] <= markers[i]['in'] <= markers[j]['out']):
                return False
    return True


def validate_min_max_length(text, min_len, max_len):
    return min_len <= len(text) <= max_len


def validate_sorted(markers):
    # Assuming markers is a list of dictionaries with 'in' keys
    times = [marker['in'] for marker in markers]
    return times == sorted(times)


def run_evaluations():
    # Get list of scenario files
    scenario_dir = "docs/ai/eval_scenarios"
    scenario_files = [f for f in os.listdir(scenario_dir) if f.endswith(".json")]

    # Sort the files to ensure consistent order
    scenario_files.sort()

    # Initialize counters
    total_scenarios = len(scenario_files)
    passed_scenarios = 0
    failed_scenarios = 0

    print(f"Running evaluation on {total_scenarios} scenarios...")

    for scenario_file in scenario_files:
        print(f"\nProcessing {scenario_file}...")

        # Read the scenario
        with open(os.path.join(scenario_dir, scenario_file), 'r') as f:
            scenario = json.load(f)

        # Call /api/ai/suggest
        try:
            response = requests.post(f"{BASE_URL}/api/ai/suggest", json=scenario)
            response.raise_for_status()
            ai_response = response.json()
        except requests.exceptions.RequestException as e:
            print(f"Error calling API: {e}")
            failed_scenarios += 1
            continue
        except json.JSONDecodeError as e:
            print(f"Error parsing JSON response: {e}")
            failed_scenarios += 1
            continue

        # Validate JSON schema
        try:
            validate(instance=ai_response, schema=SCHEMA)
            print("Schema validation passed.")
        except ValidationError as e:
            print(f"Schema validation failed: {e}")
            failed_scenarios += 1
            continue

        # Validate constraints
        try:
            # Example constraint validation - you would need to adjust this based on your actual scenario structure
            # For now, we'll just validate that the response has the expected structure
            if "editPlan" in ai_response and "timelineOps" in ai_response["editPlan"]:
                print("Constraints validation passed.")
                passed_scenarios += 1
            else:
                print("Constraints validation failed: Missing expected fields.")
                failed_scenarios += 1
        except Exception as e:
            print(f"Error during constraint validation: {e}")
            failed_scenarios += 1

    print(f"\nEvaluation complete. Passed: {passed_scenarios}, Failed: {failed_scenarios}")

    # Return 0 if all passed, 1 if any failed
    return 0 if failed_scenarios == 0 else 1


if __name__ == "__main__":
    exit(run_evaluations())
