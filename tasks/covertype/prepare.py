"""Prepares the covertype task (forest cover type, 7 classes) for Infinity Agent.

    python tasks/covertype/prepare.py [rows]

Downloads the public data set once (scikit-learn's fetch_covtype, cached under data/cache), keeps `rows` rows (default: all 581,012),
and writes with a fixed random seed:
    data/covertype/train.csv           features and the label column Cover_Type (given to every agent, read-only)
    data/covertype/test_features.csv   features only
    data/covertype-labels/test_labels.csv   the hidden labels (the task hides this directory while the agents run)
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.datasets import fetch_covtype

SEED = 20261111
TEST_FRACTION = 0.2

root = Path(__file__).resolve().parents[2] / "data"
frame = fetch_covtype(data_home=str(root / "cache"), as_frame=True).frame
rows = int(sys.argv[1]) if len(sys.argv) > 1 else len(frame)
frame = frame.sample(n=min(rows, len(frame)), random_state=SEED).reset_index(drop=True)
split = int(len(frame) * (1 - TEST_FRACTION))
train, test = frame.iloc[:split], frame.iloc[split:]

(root / "covertype").mkdir(parents=True, exist_ok=True)
(root / "covertype-labels").mkdir(parents=True, exist_ok=True)
train.to_csv(root / "covertype" / "train.csv", index=False)
test.drop(columns=["Cover_Type"]).to_csv(root / "covertype" / "test_features.csv", index=False)
test[["Cover_Type"]].to_csv(root / "covertype-labels" / "test_labels.csv", index=False)
print(f"train {len(train)} rows, test {len(test)} rows, classes {sorted(int(c) for c in np.unique(frame['Cover_Type']))}")
