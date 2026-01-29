"""
traitAgent - Image classification agent using Dashscope qwen3-vl-plus.

Classifies images based on a reference trait image.
"""

import os
import base64
import json
import csv
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any

try:
    from openai import OpenAI
except ImportError:
    raise ImportError("`openai` not installed. Please install using `pip install openai`")


# Supported image extensions
SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".heic", ".tif", ".tiff"}


def get_image_type(image_path: str) -> str:
    """Determine image MIME type from file extension."""
    ext = Path(image_path).suffix.lower()
    type_map = {
        ".jpg": "jpeg",
        ".jpeg": "jpeg",
        ".jpe": "jpeg",
        ".png": "png",
        ".bmp": "bmp",
        ".webp": "webp",
        ".heic": "heic",
        ".tif": "tiff",
        ".tiff": "tiff",
    }
    return type_map.get(ext, "")


def encode_image_to_base64(image_path: str) -> str:
    """Encode an image file to base64 string."""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def get_image_data_url(image_path: str) -> str:
    """Convert image file to data URL format."""
    image_type = get_image_type(image_path)
    if not image_type:
        raise ValueError(f"Unsupported image type: {image_path}")
    
    base64_data = encode_image_to_base64(image_path)
    return f"data:image/{image_type};base64,{base64_data}"


class TraitAgent:
    """
    Image classification agent using qwen3-vl-plus vision model.
    
    Classifies images by comparing them to a reference trait image.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: str = "qwen3-vl-plus",
    ):
        """
        Initialize the TraitAgent.

        Args:
            api_key: Dashscope API key. Defaults to DASHSCOPE_API_KEY env var.
            base_url: API base URL.
            model: Model identifier.
        """
        self.api_key = api_key or os.environ.get("DASHSCOPE_API_KEY")
        if not self.api_key:
            raise ValueError(
                "API key required. Set DASHSCOPE_API_KEY environment variable."
            )
        
        self.client = OpenAI(
            api_key=self.api_key,
            base_url=base_url,
        )
        self.model = model

    def classify(
        self,
        trait_image_url: str,
        case_image_url: str,
    ) -> Tuple[str, str]:
        """
        Classify a case image based on reference trait image.

        Args:
            trait_image_url: Data URL of the reference trait image.
            case_image_url: Data URL of the image to classify.

        Returns:
            Tuple of (classification, reason).
        """
        completion = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": f"Return results in JSON format: {json.dumps({'reason': 'string', 'class': 'string'})}",
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": trait_image_url}},
                        {"type": "image_url", "image_url": {"url": case_image_url}},
                        {
                            "type": "text",
                            "text": "Based on the classification criteria in the first image, determine which class the second image belongs to and explain your reasoning.",
                        },
                    ],
                },
            ],
            response_format={"type": "json_object"},
        )

        result = json.loads(completion.choices[0].message.content)
        return result.get("class", ""), result.get("reason", "")

    def classify_image_file(
        self,
        trait_image_path: str,
        case_image_path: str,
    ) -> Tuple[str, str]:
        """
        Classify an image file based on reference trait image file.

        Args:
            trait_image_path: Path to the reference trait image.
            case_image_path: Path to the image to classify.

        Returns:
            Tuple of (classification, reason).
        """
        trait_url = get_image_data_url(trait_image_path)
        case_url = get_image_data_url(case_image_path)
        return self.classify(trait_url, case_url)

    def batch_classify(
        self,
        trait_image: str,
        workspace: str,
        output_file: Optional[str] = None,
        recursive: bool = True,
    ) -> str:
        """
        Batch classify all images in a directory.

        Args:
            trait_image: Path to reference trait image or data URL.
            workspace: Directory containing images to classify.
            output_file: CSV output file path. Defaults to 'classification_results.csv'.
            recursive: Whether to search subdirectories.

        Returns:
            Path to the output CSV file.
        """
        workspace_path = Path(workspace).resolve()
        if not workspace_path.exists():
            raise ValueError(f"Workspace not found: {workspace}")

        # Prepare trait image URL
        if trait_image.startswith("data:"):
            trait_url = trait_image
        else:
            trait_url = get_image_data_url(trait_image)

        # Find all images
        if recursive:
            image_files = [
                f for f in workspace_path.rglob("*")
                if f.suffix.lower() in SUPPORTED_IMAGE_EXTS
            ]
        else:
            image_files = [
                f for f in workspace_path.iterdir()
                if f.is_file() and f.suffix.lower() in SUPPORTED_IMAGE_EXTS
            ]

        # Prepare output
        output_path = Path(output_file) if output_file else workspace_path / "classification_results.csv"
        results: List[Dict[str, Any]] = []

        print(f"Found {len(image_files)} images to classify...")

        for idx, image_path in enumerate(image_files, 1):
            try:
                case_url = get_image_data_url(str(image_path))
                classification, reason = self.classify(trait_url, case_url)

                result = {
                    "filename": image_path.name,
                    "path": str(image_path.relative_to(workspace_path)),
                    "class": classification,
                    "reason": reason,
                }
                results.append(result)
                print(f"[{idx}/{len(image_files)}] {image_path.name} -> {classification}")

            except Exception as e:
                result = {
                    "filename": image_path.name,
                    "path": str(image_path.relative_to(workspace_path)),
                    "class": "ERROR",
                    "reason": str(e),
                }
                results.append(result)
                print(f"[{idx}/{len(image_files)}] {image_path.name} -> ERROR: {e}")

        # Write CSV
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["filename", "path", "class", "reason"])
            writer.writeheader()
            writer.writerows(results)

        print(f"\nResults saved to: {output_path}")
        return str(output_path)

    def get_classification_summary(self, csv_path: str) -> Dict[str, int]:
        """
        Get classification summary from a results CSV.

        Args:
            csv_path: Path to classification results CSV.

        Returns:
            Dictionary mapping class names to counts.
        """
        summary: Dict[str, int] = {}
        
        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                cls = row.get("class", "Unknown")
                summary[cls] = summary.get(cls, 0) + 1

        return summary


def create_trait_agent(
    api_key: Optional[str] = None,
) -> TraitAgent:
    """
    Create a TraitAgent instance.

    Args:
        api_key: Dashscope API key. Defaults to DASHSCOPE_API_KEY env var.

    Returns:
        Configured TraitAgent instance.
    """
    return TraitAgent(api_key=api_key)


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("Usage: python traitAgent.py <trait_image> <workspace>")
        print("  trait_image: Path to reference trait image")
        print("  workspace: Directory with images to classify")
        sys.exit(1)

    trait_image = sys.argv[1]
    workspace = sys.argv[2]
    output_file = sys.argv[3] if len(sys.argv) > 3 else None

    agent = create_trait_agent()
    result_path = agent.batch_classify(trait_image, workspace, output_file)
    
    # Print summary
    summary = agent.get_classification_summary(result_path)
    print("\nClassification Summary:")
    for cls, count in sorted(summary.items()):
        print(f"  {cls}: {count}")
