/**
 * The first machine-learning task (docs/10 section 5): forest cover type, 7 classes, scored on hidden labels. It is a task form like any other.
 * Prepare the data once: `.venv-ml/bin/python tasks/covertype/prepare.py 150000` (no argument = all 581,012 rows). Needs Python with numpy, pandas and scikit-learn on PATH.
 * The paths are relative to this folder: `data/covertype` of the project (what the agents see), `data/covertype-labels` (hidden), and evaluate.py next to this file.
 */
import type { TaskForm } from "../../src/form.ts";

export default {
  preset: "code",
  name: "covertype",
  summary: "Forest cover type (7 classes), accuracy on hidden labels; needs Python with numpy, pandas, scikit-learn",
  prompt:
    "Predict the forest cover type (Cover_Type, a whole number 1 to 7) of the rows in data/test_features.csv. data/train.csv has the same features and the label column Cover_Type; " +
    "use it for training and for your own validation. Write your predictions to predictions.csv: one column named Cover_Type, one row per row of test_features.csv, in the same order. " +
    "Choose your own model, features and training procedure. Use bash to run your code and use any accelerator available to that command. " +
    "Submit the command that produced your result, predictions.csv, and the training code. The score is accuracy on hidden labels. " +
    "Use at most 10 minutes per command. " +
    "Do not download the original public covertype data set (fetch_covtype, UCI files) or look up test rows in it: that would be cheating, and it is refused.",
  data: { data: "../../data/covertype" },
  hidden: ["../../data/covertype-labels"],
  evaluate: { program: "evaluate.py", run: process.env.INFINITY_PYTHON ?? "python3" },
  metric: { name: "accuracy", direction: "max" },
  review: {
    policy: {
      hard_deny: [
        "Downloading or reading the original public covertype data set (fetch_covtype, UCI covertype files, Kaggle copies) to find the labels of the test rows.",
      ],
    },
  },
  stop: "until-stopped",
  tokens: 3_000_000,
  stuckMinutes: 15,
  submitIntervalMinutes: 2,
  evalSlots: 1,
} satisfies TaskForm;
