"""
Paper Reader Workflow - Analyze bioinformatics papers and generate methodology reports.

This workflow:
1. Takes a PDF URL (arXiv) or local file path as input
2. Downloads/locates the PDF
3. Extracts text and images
4. Analyzes with AI (Kimi 2.5) following bioinformatics best practices
5. Generates a structured methodology report in MD and PDF format

Designed to be used as an Agno Toolkit tool.
"""

import os
import sys
import re
import json
import hashlib
import requests
from pathlib import Path
from typing import Optional, List, Dict, Any, Union
from dataclasses import dataclass

# Fix imports when running as script
if __name__ == "__main__":
    current_file = Path(__file__).resolve()
    project_root = current_file.parent.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))

from agno.tools import Toolkit
from agno.agent import Agent
from agno.models.openai import OpenAILike
from agno.utils.log import log_debug, logger

# Local imports
from agent.papers_db import PapersDatabase, PaperRecord
from agent.tools.pdf_extractor import PDFExtractor, ExtractedContent


# Default directories
PAPERS_DIR = Path(__file__).parent.parent / "papers"
REPORTS_DIR = PAPERS_DIR / "reports"


@dataclass
class WorkflowResult:
    """Result of paper processing workflow."""
    paper_id: str
    success: bool
    title: Optional[str] = None
    report_md_path: Optional[str] = None
    report_pdf_path: Optional[str] = None
    error: Optional[str] = None
    cached: bool = False


# Prompt for AI analysis
ANALYSIS_PROMPT = """You are an expert bioinformatics researcher analyzing an academic paper.
Your task is to extract and document the methodology and analysis pipeline from this paper.

Focus on:
1. **Data Types**: What type of data is used (RNA-seq, WGS, ChIP-seq, proteomics, etc.)
2. **Software & Tools**: All bioinformatics tools, software, and packages mentioned
3. **Parameters**: Specific parameters and settings used
4. **Pipeline Steps**: The complete analysis workflow step by step
5. **Input/Output**: What each step takes as input and produces as output
6. **Databases**: Reference databases used (NCBI, Ensembl, UniProt, etc.)

For each analysis step, identify:
- Tool/software name and version (if mentioned)
- Command or function used
- Key parameters
- Input data format
- Output data format

If exact parameters are not mentioned, note this and suggest industry best practices.

Output your analysis as a structured JSON with the following format:
{
  "paper_info": {
    "title": "...",
    "data_type": "...",
    "organism": "..."
  },
  "pipeline_steps": [
    {
      "step_number": 1,
      "step_name": "Quality Control",
      "description": "...",
      "tools": ["FastQC", "MultiQC"],
      "input_data": "Raw FASTQ files",
      "output_data": "QC reports",
      "parameters": {"key": "value"},
      "commands_example": "fastqc *.fastq.gz",
      "best_practice_note": "..."
    }
  ],
  "databases_used": ["..."],
  "key_findings": ["..."]
}

**IMPORTANT: Output your response in Chinese (Simplified Chinese).**

Analyze the following paper content:
"""


class PaperReaderWorkflow(Toolkit):
    """Workflow for analyzing bioinformatics papers and generating methodology reports."""
    
    def __init__(
        self,
        papers_dir: Optional[Path] = None,
        db: Optional[PapersDatabase] = None,
        api_key: Optional[str] = None,
        base_url: str = "https://api.moonshot.cn/v1",
        model_id: str = "kimi-k2-thinking-turbo",
        **kwargs,
    ):
        self.papers_dir = papers_dir or PAPERS_DIR
        self.papers_dir.mkdir(parents=True, exist_ok=True)
        
        self.reports_dir = self.papers_dir / "reports"
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        
        self.db = db or PapersDatabase(self.papers_dir / "papers.db")
        self.pdf_extractor = PDFExtractor(output_base_dir=self.papers_dir)
        
        # AI Model setup
        self.api_key = api_key or os.getenv("MOONSHOT_API_KEY")
        self.base_url = base_url
        self.model_id = model_id
        
        tools = [self.analyze_paper]
        super().__init__(name="paper_reader_workflow", tools=tools, **kwargs)
    
    def _sanitize_filename(self, filename: str, max_length: int = 100) -> str:
        """Sanitize a string to be used as a filename."""
        # Remove or replace invalid characters
        invalid_chars = '<>:"/\\|?*'
        for char in invalid_chars:
            filename = filename.replace(char, '_')
        
        # Remove leading/trailing spaces and dots
        filename = filename.strip(' .')
        
        # Limit length
        if len(filename) > max_length:
            filename = filename[:max_length].rsplit(' ', 1)[0]  # Break at word boundary
        
        # Ensure it's not empty
        if not filename:
            filename = "untitled"
        
        return filename
    
    def _get_ai_model(self) -> OpenAILike:
        """Get the AI model for analysis."""
        return OpenAILike(
            id=self.model_id,
            api_key=self.api_key,
            base_url=self.base_url,
        )
    
    def _extract_arxiv_id(self, url_or_path: str) -> Optional[str]:
        """Extract arXiv ID from URL or path."""
        # Pattern for arXiv IDs like 2103.03404 or 2103.03404v1
        pattern = r"(\d{4}\.\d{4,5})(v\d+)?"
        match = re.search(pattern, url_or_path)
        if match:
            return match.group(0)
        return None
    
    def _generate_paper_id(self, url_or_path: str) -> str:
        """Generate a unique paper ID."""
        arxiv_id = self._extract_arxiv_id(url_or_path)
        if arxiv_id:
            return arxiv_id.replace(".", "_")
        # Fallback to hash
        return hashlib.md5(url_or_path.encode()).hexdigest()[:16]
    
    def _download_pdf(self, url: str, paper_id: str) -> Path:
        """Download PDF from URL (supports arXiv URLs)."""
        pdf_dir = self.papers_dir / paper_id
        pdf_dir.mkdir(parents=True, exist_ok=True)
        pdf_path = pdf_dir / f"{paper_id}.pdf"
        
        if pdf_path.exists():
            log_debug(f"PDF already exists: {pdf_path}")
            return pdf_path
        
        # Handle arXiv URLs
        download_url = url
        if "arxiv.org" in url:
            arxiv_id = self._extract_arxiv_id(url)
            if arxiv_id:
                download_url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"
        
        log_debug(f"Downloading PDF from: {download_url}")
        response = requests.get(download_url, timeout=60)
        response.raise_for_status()
        
        with open(pdf_path, "wb") as f:
            f.write(response.content)
        
        return pdf_path
    
    def _is_url(self, input_str: str) -> bool:
        """Check if input is a URL."""
        return input_str.startswith(("http://", "https://"))
    
    def _analyze_with_ai(self, text: str, image_paths: List[Path]) -> Dict[str, Any]:
        """Analyze paper content with AI."""
        model = self._get_ai_model()
        
        # Prepare prompt with text content
        # Note: For image analysis, we'd need multimodal support
        # Currently focusing on text analysis
        prompt = ANALYSIS_PROMPT + f"\n\n{text[:100000]}"  # Limit text length
        
        if image_paths:
            prompt += f"\n\n[Note: {len(image_paths)} figures were extracted from this paper]"
        
        try:
            # Create a simple agent for analysis
            agent = Agent(
                model=model,
                markdown=True,
            )
            response = agent.run(prompt)
            
            # Try to parse JSON from response
            response_text = response.content if hasattr(response, 'content') else str(response)
            
            # Extract JSON from response
            json_match = re.search(r'\{[\s\S]*\}', response_text)
            if json_match:
                return json.loads(json_match.group())
            
            # Fallback: return as raw analysis
            return {
                "raw_analysis": response_text,
                "paper_info": {},
                "pipeline_steps": [],
            }
            
        except Exception as e:
            logger.error(f"AI analysis error: {e}")
            return {
                "error": str(e),
                "paper_info": {},
                "pipeline_steps": [],
            }
    
    def _generate_report(
        self,
        paper_id: str,
        analysis: Dict[str, Any],
        extracted: ExtractedContent,
    ) -> str:
        """Generate markdown report from analysis."""
        paper_info = analysis.get("paper_info", {})
        pipeline_steps = analysis.get("pipeline_steps", [])
        databases = analysis.get("databases_used", [])
        findings = analysis.get("key_findings", [])
        
        report_parts = [
            f"# {paper_info.get('title', paper_id)}",
            "",
            "## Paper Information",
            f"- **Paper ID**: {paper_id}",
            f"- **Data Type**: {paper_info.get('data_type', 'Not specified')}",
            f"- **Organism**: {paper_info.get('organism', 'Not specified')}",
            f"- **Pages Analyzed**: {extracted.page_count}",
            f"- **Figures Extracted**: {extracted.image_count}",
            "",
            "---",
            "",
            "## Analysis Pipeline",
            "",
        ]
        
        for step in pipeline_steps:
            step_num = step.get("step_number", "?")
            step_name = step.get("step_name", "Unknown Step")
            tools_raw = step.get("tools", [])
            tools: List[str] = []
            for tool in tools_raw:
                if isinstance(tool, str):
                    tools.append(tool)
                elif isinstance(tool, dict):
                    name = tool.get("name") or tool.get("tool") or ""
                    version = tool.get("version")
                    parts = [p for p in [name, version] if p]
                    if parts:
                        tools.append(" ".join(parts))
                    else:
                        tools.append(json.dumps(tool, ensure_ascii=False))
                else:
                    tools.append(str(tool))
            tools_text = ", ".join(tools) if tools else "Not specified"
            
            report_parts.extend([
                f"### Step {step_num}: {step_name}",
                "",
                f"**Description**: {step.get('description', 'N/A')}",
                "",
                f"**Tools**: {tools_text}",
                "",
                f"**Input**: {step.get('input_data', 'N/A')}",
                "",
                f"**Output**: {step.get('output_data', 'N/A')}",
                "",
            ])
            
            params = step.get("parameters", {})
            if params:
                report_parts.append("**Parameters**:")
                for k, v in params.items():
                    report_parts.append(f"- `{k}`: {v}")
                report_parts.append("")
            
            cmd = step.get("commands_example")
            if cmd:
                report_parts.extend([
                    "**Example Command**:",
                    "```bash",
                    cmd,
                    "```",
                    "",
                ])
            
            note = step.get("best_practice_note")
            if note:
                report_parts.extend([
                    f"> **Best Practice Note**: {note}",
                    "",
                ])
            
            report_parts.append("")
        
        # Databases section
        if databases:
            report_parts.extend([
                "---",
                "",
                "## Databases Used",
                "",
            ])
            for db in databases:
                report_parts.append(f"- {db}")
            report_parts.append("")
        
        # Key findings
        if findings:
            report_parts.extend([
                "---",
                "",
                "## Key Methodological Findings",
                "",
            ])
            for finding in findings:
                report_parts.append(f"- {finding}")
            report_parts.append("")
        
        # Handle raw analysis fallback
        if not pipeline_steps and analysis.get("raw_analysis"):
            report_parts.extend([
                "---",
                "",
                "## AI Analysis",
                "",
                analysis["raw_analysis"],
                "",
            ])
        
        # Footer
        report_parts.extend([
            "---",
            "",
            "*Report generated by Paper Reader Workflow*",
        ])
        
        return "\n".join(report_parts)
    
    def _export_pdf(self, md_path: Path) -> Optional[Path]:
        """Convert markdown report to PDF using best available tool."""
        pdf_path = md_path.with_suffix(".pdf")
        
        # Try weasyprint first
        try:
            from weasyprint import HTML, CSS
            import markdown
            
            # Convert markdown to HTML
            with open(md_path, "r", encoding="utf-8") as f:
                md_content = f.read()
            
            html_content = markdown.markdown(
                md_content,
                extensions=["tables", "fenced_code", "codehilite"]
            )
            
            # Wrap in HTML document with styling
            full_html = f"""
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    body {{ font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }}
                    h1, h2, h3 {{ color: #333; }}
                    code {{ background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }}
                    pre {{ background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }}
                    blockquote {{ border-left: 3px solid #0066cc; margin-left: 0; padding-left: 15px; color: #666; }}
                    hr {{ border: none; border-top: 1px solid #ddd; margin: 20px 0; }}
                    table {{ border-collapse: collapse; width: 100%; }}
                    th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
                    th {{ background: #f4f4f4; }}
                </style>
            </head>
            <body>
                {html_content}
            </body>
            </html>
            """
            
            HTML(string=full_html).write_pdf(str(pdf_path))
            return pdf_path
            
        except ImportError:
            log_debug("weasyprint not available, skipping PDF export")
        except Exception as e:
            logger.error(f"PDF export error: {e}")
        
        return None
    
    def analyze_paper(self, pdf_url_or_path: str) -> str:
        """Analyze a bioinformatics paper and generate a methodology report.
        
        This tool processes a PDF (from URL or local path) to extract and document
        the bioinformatics analysis pipeline, tools, and parameters used.
        
        Args:
            pdf_url_or_path (str): Either an arXiv PDF URL or a local file path.
                Examples:
                - "https://arxiv.org/pdf/2103.03404.pdf"
                - "/path/to/paper.pdf"
        
        Returns:
            str: JSON containing the workflow result with report paths.
        """
        try:
            paper_id = self._generate_paper_id(pdf_url_or_path)
            
            # Check cache first
            cached_record = self.db.get_completed(paper_id)
            if cached_record and cached_record.report_md:
                log_debug(f"Using cached report for {paper_id}")
                return json.dumps({
                    "paper_id": paper_id,
                    "success": True,
                    "cached": True,
                    "report_md_path": str(self.reports_dir / f"{paper_id}.md"),
                    "report_pdf_path": cached_record.report_pdf_path,
                }, indent=2)
            
            # Create or update record
            record = PaperRecord(
                paper_id=paper_id,
                source_url=pdf_url_or_path if self._is_url(pdf_url_or_path) else None,
                local_path=None if self._is_url(pdf_url_or_path) else pdf_url_or_path,
                status="processing",
            )
            self.db.upsert(record)
            
            # Get PDF file
            if self._is_url(pdf_url_or_path):
                pdf_path = self._download_pdf(pdf_url_or_path, paper_id)
            else:
                pdf_path = Path(pdf_url_or_path)
                if not pdf_path.exists():
                    raise FileNotFoundError(f"PDF not found: {pdf_path}")
            
            record.pdf_path = str(pdf_path)
            self.db.upsert(record)
            
            # Extract content
            log_debug(f"Extracting content from {pdf_path}")
            extracted = self.pdf_extractor.extract(str(pdf_path), paper_id)
            
            self.db.save_extracted_content(
                paper_id,
                extracted.text,
                str(extracted.images_dir),
            )
            
            # Analyze with AI
            log_debug(f"Analyzing paper with AI...")
            image_paths = self.pdf_extractor.get_image_paths(paper_id)
            analysis = self._analyze_with_ai(extracted.text, image_paths)
            
            # Generate report
            log_debug(f"Generating report...")
            report_md = self._generate_report(paper_id, analysis, extracted)
            
            # Determine filename based on paper title
            paper_title = analysis.get("paper_info", {}).get("title")
            if paper_title:
                filename_base = self._sanitize_filename(paper_title)
            else:
                filename_base = paper_id
            
            # Save MD report
            md_path = self.reports_dir / f"{filename_base}.md"
            
            # Handle duplicate filenames
            counter = 1
            while md_path.exists():
                md_path = self.reports_dir / f"{filename_base}_{counter}.md"
                counter += 1
            
            with open(md_path, "w", encoding="utf-8") as f:
                f.write(report_md)
            
            # Export PDF
            pdf_report_path = self._export_pdf(md_path)
            
            # Save to database
            self.db.save_report(
                paper_id,
                report_md,
                str(pdf_report_path) if pdf_report_path else None,
            )
            
            result = WorkflowResult(
                paper_id=paper_id,
                success=True,
                title=analysis.get("paper_info", {}).get("title"),
                report_md_path=str(md_path),
                report_pdf_path=str(pdf_report_path) if pdf_report_path else None,
                cached=False,
            )
            
            return json.dumps({
                "paper_id": result.paper_id,
                "success": result.success,
                "title": result.title,
                "report_md_path": result.report_md_path,
                "report_pdf_path": result.report_pdf_path,
                "cached": result.cached,
            }, indent=2)
            
        except Exception as e:
            logger.error(f"Workflow error: {e}")
            self.db.update_status(paper_id, "failed")
            
            return json.dumps({
                "paper_id": paper_id if 'paper_id' in locals() else None,
                "success": False,
                "error": str(e),
            }, indent=2)


def create_paper_reader_workflow(
    api_key: Optional[str] = None,
    papers_dir: Optional[Path] = None,
    **kwargs,
) -> PaperReaderWorkflow:
    """Create a PaperReaderWorkflow instance.
    
    Args:
        api_key: Moonshot API key. Defaults to MOONSHOT_API_KEY env var.
        papers_dir: Directory for storing papers and reports.
        **kwargs: Additional arguments passed to Toolkit.
        
    Returns:
        Configured PaperReaderWorkflow instance.
    """
    return PaperReaderWorkflow(
        api_key=api_key,
        papers_dir=papers_dir,
        **kwargs,
    )


# Module-level default instance
_default_workflow: Optional[PaperReaderWorkflow] = None


def get_paper_reader_workflow() -> PaperReaderWorkflow:
    """Get or create the default PaperReaderWorkflow instance."""
    global _default_workflow
    if _default_workflow is None:
        _default_workflow = create_paper_reader_workflow()
    return _default_workflow


if __name__ == "__main__":
    workflow = create_paper_reader_workflow()
    
    if len(sys.argv) > 1:
        pdf_input = sys.argv[1]
        print(f"Processing: {pdf_input}")
        result = workflow.analyze_paper(pdf_input)
        print(result)
    else:
        print("Usage: python paperReaderWorkflow.py <pdf_url_or_path>")
        print("Example: python paperReaderWorkflow.py https://arxiv.org/pdf/2103.03404.pdf")
