"""视觉分类提示词与结构化输出约束。"""
from __future__ import annotations

from dataclasses import dataclass

from .. import config


SYSTEM_PROMPT = """\
You are a strict, auditable visual classification engine. You will receive two images:
- The first image is the complete reference image (REFERENCE), which may show multiple categories or standard examples.
- The second image is the image to classify (TARGET).

Classify TARGET according to the category rules supplied by the user.
You must follow these rules:
1. Never swap the REFERENCE and TARGET roles. Never use filenames, paths, batch IDs, or image numbers as evidence.
2. Use only visible visual evidence and the rules explicitly supplied by the user. Do not infer invisible states.
3. Check each visible feature in `spotting_features`. Each feature state must be PRESENT, ABSENT, or UNCLEAR, with brief evidence.
4. Select the best matching category. If no category matches sufficiently, use predicted_category = UNKNOWN and status = UNKNOWN.
5. status must be CLASSIFIED, UNKNOWN, or REVIEW. Use REVIEW when categories are difficult to distinguish, the image is blurry, occluded, or a key feature is unclear, and provide review reasons.
6. Do not output numeric score or confidence. Do not present subjective numbers as probabilities.
7. reasoning_summary must be a short summary of final visible evidence. Do not output hidden chain-of-thought.
8. The output must strictly match the supplied JSON Schema. Do not output Markdown, code fences, extra explanation, or fields outside the Schema."""


USER_PROMPT_TEMPLATE = """\
You will receive two images:
- image[0] = REFERENCE: the complete reference image or category example set.
- image[1] = TARGET: the image to classify.

Task rules:
{criteria_text}

Do the following:
1. Check whether both images are clear and comparable, and whether TARGET contains a classifiable object.
2. Identify the category using the task rules and record each spotting feature.
3. Use only PRESENT, ABSENT, or UNCLEAR for each feature. Do not invent invisible details.
4. Return predicted_category, status, spotting_features, candidate_categories, image_quality, reasoning_summary, and review.
5. status must be CLASSIFIED, UNKNOWN, or REVIEW.
6. Do not return numeric scores, confidence values, or extra text.
7. Return exactly one JSON object that strictly follows the supplied JSON Schema."""


REPAIR_SUFFIX = (
    "\nThe previous output did not match the JSON Schema. Retry now: return only one valid JSON object "
    "that strictly matches the ImageJudge 2.0 classification Schema. Do not output numeric score/confidence, "
    "Markdown, code fences, or explanation."
)


DEFAULT_CRITERIA = (
    "Use the category examples shown in REFERENCE to classify TARGET. "
    "Compare visible appearance, color, shape, outline, pose, and other observable details. "
    "If the category cannot be distinguished clearly from the reference and rules, return REVIEW or UNKNOWN."
)


@dataclass(frozen=True)
class PromptBundle:
    """一次请求的完整提示词。"""

    system_prompt: str
    user_prompt: str
    prompt_version: str
    schema_version: str


def build_user_prompt(criteria_text: str) -> str:
    return USER_PROMPT_TEMPLATE.format(criteria_text=criteria_text or DEFAULT_CRITERIA)


def build_messages_payload(criteria_text: str) -> PromptBundle:
    return PromptBundle(
        system_prompt=SYSTEM_PROMPT,
        user_prompt=build_user_prompt(criteria_text),
        prompt_version=config.PROMPT_VERSION,
        schema_version=config.OUTPUT_SCHEMA_VERSION,
    )
