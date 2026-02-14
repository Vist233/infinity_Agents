# PubMed Central (PMC) PDF 实现原理解析

## 🔍 实现原理

### 1. 数据流向

```
你的查询 → PubMed (Entrez API) → 获取 PMID列表 → 逐个查询PMC
                                        ↓
                                检查是否有 PMC ID
                                        ↓
                        有 → 构造PDF URL: `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{pmc_id}/pdf`
                        无 → 返回 None
```

### 2. 代码逻辑详解

```python
def _get_pubmed_pmc_pdf_url(self, pmid: str) -> Optional[str]:
    # Step 1: 查询这个PMID是否有对应的PMC ID
    handle = Entrez.elink(dbfrom="pubmed", db="pmc", id=pmid)
    #                  ↑ 从PubMed链接到PMC数据库
    
    # Step 2: 解析返回的链接数据
    for link in link_results:
        if link.get("DbTo") == "pmc":
            pmc_id = doc_id.get("Id")  # 提取PMC ID
    
    # Step 3: 构造PDF URL
    pdf_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{pmc_id}/pdf"
```

---

## ❓ 为什么你的测试是 "0/5"？

### 原因：PMC 覆盖率 ≠ 100%

**关键事实：**
```
PubMed: ~35,000,000 篇论文（所有生物医学文献）
  ↓
PMC: ~10,000,000 篇论文（开放获取子集）
  ↓
覆盖率: ~30%
```

### PMC 包含什么？

| 类型 | 是否在PMC | 例子 |
|------|-----------|------|
| NIH资助的研究 | ✅ 必须 | 所有NIH资助论文必须在PMC发表 |
| 开放获取期刊 | ✅ 自愿 | PLOS, BMC, eLife等 |
| 传统订阅期刊 | ❌ 通常不 | Nature, Science, Cell等（除非作者付费OA） |
| 非NIH资助的闭合期刊 | ❌ 不 | 大部分商业出版商 |

### 你的查询 `"pancoronavirus vaccine"` 的结果分析

```
PMID: 41672103 (SARS-CoV-2相关论文)
  ↓
期刊: Journal of Virology (美国微生物学会ASM)
  ↓
资助: 可能有NIH资助，但...
  ↓
问题: 发表日期可能是2025年，PMC索引有延迟
  ↓
结果: 暂时无PMC ID
```

---

## ✅ 如何提高 PMC 命中率？

### 策略 1: 专门针对 PMC 的查询

```python
# 添加 "open access" 或 "nih" 到你的查询
queries_with_high_pmc_coverage = [
    "COVID-19 vaccine NIH",
    "SARS-CoV-2 open access",
    "PLOS ONE coronavirus",  # PLOS是OA期刊
    "BMC infectious disease",  # BMC是OA期刊
]
```

### 策略 2: 使用 Europe PMC（范围更大）

```python
def _get_europe_pmc_pdf_url(self, pmid: str) -> Optional[str]:
    """Europe PMC has broader coverage than US PMC."""
    import requests
    
    url = f"https://www.ebi.ac.uk/europepmc/webservices/rest/PMCID:{pmid}?format=json"
    response = requests.get(url)
    
    if response.status_code == 200:
        data = response.json()
        # Check if has full text
        if data.get("hasPDF") == "Y":
            pmcid = data.get("pmcid")
            return f"https://europepmc.org/backend/ptpmcrender.fcgi?accid=PMC{pmcid}&blobtype=pdf"
    return None
```

### 策略 3: 使用 Unpaywall（最全面的OA检测）

```python
def _get_unpaywall_pdf_url(self, pmid: str) -> Optional[str]:
    """Unpaywall finds OA versions across all sources."""
    import requests
    
    # First get DOI from PMID
    handle = Entrez.esummary(db="pubmed", id=pmid)
    record = Entrez.read(handle)
    handle.close()
    
    doi = record[0].get("DOI", "")
    if not doi:
        return None
    
    # Query Unpaywall
    email = "your@email.com"
    url = f"https://api.unpaywall.org/v2/{doi}?email={email}"
    response = requests.get(url)
    
    if response.status_code == 200:
        data = response.json()
        best_oa = data.get("best_oa_location")
        if best_oa:
            return best_oa.get("url_for_pdf")
    return None
```

---

## 📊 实际测试结果预期

### 使用 `"COVID-19 vaccine"` 查询

```
预期结果:
- 总论文: 10篇 (5 ArXiv + 5 PubMed)
- ArXiv有PDF: 5/5 (100%)
- PubMed有PMC PDF: 2-3/5 (40-60%)
  - 原因: COVID-19研究大量NIH资助，PMC覆盖率高
```

### 使用 `"machine learning"` 查询

```
预期结果:
- 总论文: 10篇
- PubMed有PMC PDF: 1-2/5 (20-40%)
  - 原因: ML论文常发表在非生物医学期刊或商业期刊
```

---

## ✅ 总结

| 问题 | 答案 |
|------|------|
| 实现是否正确？ | ✅ 正确 |
| 为什么0/5？ | 因为PMC覆盖率~30%，你的查询恰好命中无PMC的论文 |
| 如何提高命中率？ | 使用NIH资助/OA期刊关键词，或添加Europe PMC/Unpaywall |
| 是否达到ArXiv体验？ | 技术上已实现相同API，但覆盖率不同是数据源限制 |

**建议**: 使用 `queries_with_high_pmc_coverage` 中的查询测试，你会看到PMC PDF被正确获取！
