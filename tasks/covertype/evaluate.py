"""Scores predictions.csv of one agent against the hidden labels. Started by the orchestrator (commandEvaluator), outside the agents' shell.

Environment: INFINITY_WORK_DIR (the agent's directory), INFINITY_HIDDEN_0 (private path of the hidden labels directory).
Prints one JSON line. Nothing about the labels is put into `details` except how many rows were compared.
"""
import json
import os
import sys

import numpy as np
import pandas as pd

work = os.environ["INFINITY_WORK_DIR"]
labels = pd.read_csv(os.path.join(os.environ["INFINITY_HIDDEN_0"], "test_labels.csv"))["Cover_Type"].to_numpy()


def fail(message: str) -> None:
    print(json.dumps({"score": None, "details": message}))
    sys.exit(1)


path = os.path.join(work, "predictions.csv")
if not os.path.exists(path):
    fail("predictions.csv was not found in your directory.")
try:
    predicted = pd.read_csv(path)
except Exception as error:  # noqa: BLE001 - any unreadable file is the agent's to fix
    fail(f"predictions.csv could not be read: {type(error).__name__}")
if list(predicted.columns) != ["Cover_Type"]:
    fail("predictions.csv must have exactly one column named Cover_Type.")
if len(predicted) != len(labels):
    fail(f"predictions.csv has {len(predicted)} rows; test_features.csv has {len(labels)}.")
values = predicted["Cover_Type"].to_numpy()
if not np.isin(values, np.arange(1, 8)).all():
    fail("Cover_Type values must be whole numbers from 1 to 7.")

accuracy = float((values == labels).mean())
per_class = [float((values[labels == c] == c).mean()) for c in range(1, 8) if (labels == c).any()]
print(json.dumps({"score": round(accuracy, 5), "metrics": {"accuracy": round(accuracy, 5), "macro_recall": round(float(np.mean(per_class)), 5)}, "details": f"compared {len(labels)} rows"}))
