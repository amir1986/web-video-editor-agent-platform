# Evaluation Scenarios

This directory contains 20 synthetic scenarios for evaluating the AI agent.

Each scenario is a JSON file that represents a user request for video editing.

## Structure

Each scenario file should contain:
- A description of the request
- The expected outcome
- Any constraints or requirements

## Files

- scenario_01.json
- scenario_02.json
...
- scenario_20.json

## Usage

The evaluation script will read each scenario and call /api/ai/suggest to get the AI's response.
Then it will validate the response against the JSON schema and constraints.

## Constraints

- Range validation (e.g., time values must be within video duration)
- Non-overlap validation (e.g., In/Out markers must not overlap)
- Min/max length validation (e.g., title text must be between 1 and 100 characters)
- Sorted validation (e.g., timeline markers must be in chronological order)
