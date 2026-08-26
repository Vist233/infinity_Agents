"""Dedicated Paper Processor control-plane client.

This package intentionally contains only the narrow HTTPS protocol client. PDF
admission, extraction, and image rendering are added in later execution cards.
"""

from .client import PaperProcessorClient

__all__ = ["PaperProcessorClient"]
