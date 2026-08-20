"""Infinity Agents task package.

The D1 Worker image imports this package while deliberately not installing the
legacy PostgreSQL/Redis application dependencies. Keep package import side
effects empty; the web API imports its historical modules explicitly.
"""

__all__: list[str] = []
