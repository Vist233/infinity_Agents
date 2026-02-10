# PANGEA: A FULLY OPEN MULTILINGUAL MULTI-MODAL LLM FOR 39 LANGUAGES

## Paper Information
- **Paper ID**: 2410_16153v1
- **Data Type**: 多模态指令微调数据（图像-文本对）
- **Organism**: 不适用
- **Pages Analyzed**: 52
- **Figures Extracted**: 85

---

## Analysis Pipeline

### Step 1: 英文指令数据收集

**Description**: 从现有开源数据集中收集高质量的英文多模态指令数据，涵盖视觉理解、图表问答、图像描述、纯文本指令（代码、数学）等多种任务类型

**Tools**: 人工收集, 学术数据集

**Input**: 原始英文多模态数据集（LLaVA、Cambrian、ChartQA等）及纯文本数据集（Code-Feedback、NuminaMath、OpenHermes-2.5）

**Output**: 高质量英文指令池

**Parameters**:
- `数据来源`: LLaVA-4V, Cambrian, LVIS-Instruct4V, ChartQA, Doc-VQA, 等
- `数据规模`: 约250万英文样本

**Example Command**:
```bash
人工筛选和整理现有数据集
```

> **Best Practice Note**: 使用经过验证的高质量数据集作为翻译基础；确保数据覆盖多样化的视觉理解任务和纯文本任务


### Step 2: 机器翻译指令

**Description**: 将英文指令翻译成39种语言。初始尝试开源NLLB-3B模型但效果不佳，最终采用专有Gemini 1.5 Pro模型进行翻译，确保复杂指令场景和代码/数学领域的翻译质量

**Tools**: Gemini 1.5 Pro, NLLB-3B（已弃用）

**Input**: 高质量英文指令池

**Output**: 39种语言的翻译指令数据

**Parameters**:
- `翻译模型`: Gemini 1.5 Pro
- `目标语言`: 39种类型多样的语言
- `翻译策略`: 直接翻译整批指令

**Example Command**:
```bash
通过API调用Gemini 1.5 Pro进行批处理翻译
```

> **Best Practice Note**: 对于复杂指令，建议使用GPT-4级别以上的大语言模型而非传统MT模型；翻译后需进行质量检查，特别是代码关键字和数学符号的准确性


### Step 3: 翻译后处理

**Description**: 开发自动化后处理管道，修正翻译后数据中的不一致问题，如对话轮次不匹配、多选题选项缺失等，确保所有翻译指令的一致性

**Tools**: 自定义后处理管道

**Input**: 原始翻译指令数据

**Output**: 清洗后的翻译指令数据

**Parameters**:
- `错误类型`: 对话轮次不匹配、选项缺失
- `处理方式`: 自动修正或直接丢弃问题样本

**Example Command**:
```bash
python post_process_translations.py --input translated.json --output cleaned.json
```

> **Best Practice Note**: 未提供具体实现细节。建议实施规则基础检查（如JSON结构验证、选项数量匹配）和统计异常检测


### Step 4: 文化多样性图像筛选

**Description**: 从LAION-Multi数据集中采样1000万张图像，通过启发式过滤和LLM评分筛选出100万张高质量、文化特异性的图像

**Tools**: LAION-Multi, CLIP, Llama-3.1-8B-Instruct

**Input**: LAION-Multi数据集（1000万张图像及alt文本）

**Output**: 100万张文化相关的高质量图像及元数据

**Parameters**:
- `启发式过滤条件`: {'图像尺寸': '224-4096像素', '宽高比': '0.25-3.0', '文本长度': '5-5000字符', 'CLIP分数': '>0.3', 'NSFW内容': '排除', '重复内容': '去重'}
- `LLM评分标准`: {'模型': 'Llama-3.1-8B-Instruct', '文本质量评分': '1-5分，保留≥4分', '主题分类': '11个预定义类别', '国家/地区分类': '识别特定文化关联'}
- `最终筛选`: 排除'无特定国家'图像（约60%），避免过度采样常见主题

**Example Command**:
```bash
python cultural_filter.py --images laion_multi/ --clip-score 0.3 --llm-model meta-llama/Llama-3.1-8B-Instruct
```

> **Best Practice Note**: CLIP分数阈值0.3确保图文对齐；LLM评分剔除低质量描述；保持地理和主题平衡以避免偏见


### Step 5: 多文化图像重描述

**Description**: 使用Gemini 1.5 Pro基于筛选后的高质量alt文本，为每张图像生成详细的文化相关描述，使用图像原产国的语言

**Tools**: Gemini 1.5 Pro

**Input**: 筛选后的图像 + 高质量alt文本 + 文化元数据（国家、主题）

**Output**: 多语言详细图像描述

**Parameters**:
- `生成模型`: Gemini 1.5 Pro
- `描述语言`: 图像文化原产国语言
- `提示策略`: 5种变体的prompt模板，包含国家、主题和原alt文本信息

**Example Command**:
```bash
gemini.generate_caption(prompt=f'请用{language}详细描述这张可能关联{country}和{category}的图像。原标题：{text}')
```

> **Best Practice Note**: 利用原alt文本中的文化特定信息（如地点、人物身份）增强描述细节；多prompt变体可增加多样性


### Step 6: 多文化指令生成

**Description**: 基于详细描述，使用Gemini 1.5 Pro生成最多2个QA指令对，从13个预定义任务类型中选择，确保指令多样性和文化敏感性

**Tools**: Gemini 1.5 Pro

**Input**: 多语言详细图像描述

**Output**: 指令-响应对（最多2个/图像）

**Parameters**:
- `生成模型`: Gemini 1.5 Pro
- `任务类型`: 13种（信息检索、代码调试、创造性写作、批判性推理、规划策略、数学思维、文本修订、数据分析、角色扮演、头脑风暴、建议寻求、学习理解、文化解读）
- `每图像样本数`: 最多2个不同任务类型的QA对

**Example Command**:
```bash
gemini.generate_instruction(caption, language, task_types=13, max_pairs=2)
```

> **Best Practice Note**: 显式指定任务类型可确保指令多样性；限制每图像样本数避免过拟合特定视觉内容


### Step 7: 开源数据集整合

**Description**: 调研并整合现有高质量开源多语言多模态数据集，补充语言和文化覆盖

**Tools**: HuggingFace数据集

**Input**: 多个开源数据集

**Output**: 整合后的多语言数据子集

**Parameters**:
- `整合数据集`: ['Chinese ALLaVA-4V', 'Viet Document and OCR QA', 'Llava Chinese', 'Llava Medical Chinese Instruction', 'LLaVA-Japanese-Instruct', 'MTVQA', 'Japanese STAIR Captions', 'Russian GQA', 'French Doc-VQA', 'French Table-VQA']

**Example Command**:
```bash
datasets.load_dataset()
```

> **Best Practice Note**: 保留原始数据格式和质量标准；确保语言和文化多样性覆盖


### Step 8: 数据集混合

**Description**: 将翻译数据、文化理解数据和开源数据混合，构建最终的PANGEA INS训练集，保持英文与多语言40%:60%的比例

**Tools**: 数据混合脚本

**Input**: 翻译指令、文化理解指令、开源指令

**Output**: PANGEA INS（600万样本）

**Parameters**:
- `总样本量`: 600万
- `英文比例`: 40%（250万）
- `翻译数据`: 19%（120万）
- `文化数据`: 24%（150万）
- `开源数据`: 17%（100万）
- `多语言比例`: 60%（370万）

**Example Command**:
```bash
python mix_dataset.py --ratio en:40 --ratio mul:60 --output pangea_ins.jsonl
```

> **Best Practice Note**: 实验表明40%英文数据最有利于跨语言迁移；过度依赖英文会损害多语言性能


### Step 9: 模型训练

**Description**: 基于LLaVA-Next架构，使用Qwen2-7B-Instruct作为语言模型主干，在PANGEA INS上进行指令微调

**Tools**: LLaVA-Next架构, Qwen2-7B-Instruct, PyTorch/Transformer框架

**Input**: PANGEA INS数据集

**Output**: PANGEA-7B模型

**Parameters**:
- `基础架构`: LLaVA-Next
- `语言模型主干`: Qwen2-7B-Instruct
- `学习率`: 2e-5
- `批大小`: 512
- `训练轮次`: 1 epoch
- `调度器`: cosine decay with 0.03 warmup steps
- `优化器`: 未明确提及，假设为AdamW

**Example Command**:
```bash
torchrun --nproc_per_node=8 train.py --model llava-next-qwen2-7b --dataset pangea_ins --lr 2e-5 --batch_size 512 --epochs 1
```

> **Best Practice Note**: 1 epoch训练防止过拟合；大batch size（512）配合cosine调度器是标准做法；warmup比例3%適中


### Step 10: OCR能力增强（探索性）

**Description**: 构建50万条多语言OCR指令数据（10种语言，每种5万条），专门提升模型对网页截图文本提取能力

**Tools**: 网页截图工具, OCR标注流程

**Input**: 各国网站截图

**Output**: 多语言OCR训练集

**Parameters**:
- `数据规模`: 50万条
- `语言数量`: 10种
- `每语言样本`: 5万条
- `数据来源`: 网页用户界面截图

**Example Command**:
```bash
python collect_ocr_data.py --languages en,ar,es,fr,hi,id,js,ko,pt,zh --total_samples 500000
```

> **Best Practice Note**: 非拉丁文字（中文、日文、韩文）OCR准确率仍低于拉丁语言；需要更多样化的训练数据和字体覆盖


### Step 11: 模型评估

**Description**: 使用PANGEA BENCH进行全面评估，包含5个多模态任务和3个纯文本任务，覆盖14个数据集47种语言

**Tools**: lmms-eval, lm-evaluation-harness, GPT-4o（作为评估裁判）

**Input**: PANGEA-7B模型 + 评估数据集

**Output**: 多任务性能指标

**Parameters**:
- `评估框架`: lmms-eval（多模态）, lm-evaluation-harness（文本）
- `多模态任务`: ['多模态对话', '图像描述', '文化理解', '多语言VQA', '多主题推理']
- `文本任务`: ['问答', '翻译', '推理']
- `评估裁判`: GPT-4o（用于xChatBench细粒度评估）
- `评分方式`: 1-5分制，后转换为0-100分

**Example Command**:
```bash
lmms-eval --model pangea-7b --tasks xgqa,mxm3600,cvqa --languages all
```

> **Best Practice Note**: 使用LLM-as-Judge时提供细粒度评估标准比粗粒度提示更准确；必须检测语言幻觉（用langdetect）并对非目标语言回复评0分


---

## Databases Used

- LAION-Multi（图像来源）
- LAION-5B
- ALLaVA-4V（中文多模态）
- Viet-Doc-VQA（越南语文档问答）
- Viet-OCR-VQA（越南语OCR问答）
- Llava-Med-Zh（中文医学）
- STAIR Captions（日语文本）
- GQA-ru（俄语视觉问答）
- Doc-VQA-Fr（法语文档问答）
- ChartQA（图表问答）
- OpenHermes-2.5（通用指令）
- NuminaMath（数学推理）
- xGQA（跨语言视觉问答）
- MaXM（多文化VQA）
- MaRVL（多文化推理）
- XM3600/XM100（多语言描述）
- M3Exam（多语言教育考试）
- MMMU（大学水平多模态推理）
- TyDiQA（多样语言问答）
- FLORES-200（机器翻译）
- MMMLU（多语言理解）
- MGSM（多语言数学）
- XStoryCloze（常识推理）

---

## Key Methodological Findings

- PANGEA-7B在英语任务上平均超越最强开源模型7.3分，在多语言任务上超越10.8分
- 最优数据配比为40%英语 + 60%多语言，纯多语言数据反而导致性能下降
- 随着多语言指令数据量增加，模型在英语和多语言任务上均呈现稳定的缩放效应
- 低资源语言即使少量数据增加也能带来不成比例的性能提升，且存在类型相似语言间的正向迁移
- 多模态大语言模型普遍存在语言幻觉问题（用英语回复非英语查询），需严格惩罚
- 多语言OCR对非拉丁文字（中文、日文、韩文）的准确率显著低于拉丁语言，需要针对性数据增强
- 在文本-only任务上，PANGEA-7B保持甚至超越其Qwen2-7B-Instruct主干模型的性能，证明多模态训练未损害语言能力
- xChatBench的细粒度LLM评估比粗粒度评估更能准确反映模型真实能力

---

*Report generated by Paper Reader Workflow*