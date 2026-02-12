# Beyond Self-attention: External Attention using Two Linear Layers for Visual Tasks

## Paper Information
- **Paper ID**: 2105_02358v2
- **Data Type**: 计算机视觉多任务数据（图像分类、目标检测、语义分割、实例分割、图像生成、点云分类与分割）
- **Organism**: 不适用（计算机视觉研究）
- **Pages Analyzed**: 11
- **Figures Extracted**: 176

---

## Analysis Pipeline

### Step 1: 核心方法：外部注意力机制

**Description**: 实现外部注意力（External Attention, EA）模块，用两个可学习的外部记忆单元替代自注意力。输入特征与键记忆单元计算注意力图，再与值记忆单元相乘得到输出特征。复杂度从O(N²)降至O(N)。

**Tools**: PyTorch, Jittor

**Input**: 特征图 F ∈ R^(B×N×C)，其中B为批大小，N为像素/元素数量，C为通道数

**Output**: 精炼特征图 F_out ∈ R^(B×N×C)

**Parameters**:
- `memory_units_S`: 64（推荐值，可取值8, 32, 64, 256）
- `normalization`: 双归一化（先列后行）
- `linear_layer_bias`: False
- `dimension_d`: 与输入特征维度一致
- `algorithm`: A = softmax(l1_norm(F × M_k^T)) ; F_out = A × M_v

**Example Command**:
```bash
# 伪代码见Algorithm 1
attn = M_k(F)  # shape=(B, N, M)
attn = softmax(attn, dim=1)
attn = l1_norm(attn, dim=2)
out = M_v(attn)  # shape=(B, N, C)
```

> **Best Practice Note**: 记忆单元数量S远小于N（如S=64时性能良好），双归一化对外部注意力效果至关重要。线性层不使用偏置项以增强正则化。


### Step 2: 多头外部注意力机制

**Description**: 将外部注意力扩展为多头版本（Multi-head EA），共享跨头的记忆单元，最后通过线性变换Wo整合各头输出。平衡头数H和记忆单元数S（可同步缩放）。

**Tools**: PyTorch, Jittor

**Input**: 特征图 F ∈ R^(B×N×C_in)

**Output**: 多头精炼特征图 F_out ∈ R^(B×N×C_in)

**Parameters**:
- `num_heads_H`: 16, 24, 32（根据模型规模）
- `memory_units_S`: 64（多头间共享）
- `head_dim`: C // H
- `Wo_linear`: 最终整合变换矩阵

**Example Command**:
```bash
# 伪代码见Algorithm 2
F = query_linear(F).view(B, N, H, C//H).permute(0,2,1,3)
attn = M_k(F)  # shape=(B, H, N, M)
attn = softmax(attn, dim=2)
attn = l1_norm(attn, dim=3)
out = M_v(attn)  # shape=(B, H, N, C//H)
out = out.permute(0,2,1,3).view(B, N, C)
out = W_o(out)
```

> **Best Practice Note**: 多头机制对外部注意力至关重要，不同头可捕获不同特征关系。记忆单元跨头共享减少参数，最终线性层Wo确保输入输出维度一致。


### Step 3: 消融实验（PASCAL VOC分割）

**Description**: 在PASCAL VOC验证集上验证外部注意力模块的有效性，对比自注意力、不同记忆单元数和归一化方法。采用FCN作为骨干网络。

**Tools**: Jittor, PyTorch, FCN, ResNet

**Input**: PASCAL VOC训练集（10,582图像）和验证集（1,449图像），20类前景+背景

**Output**: mIoU精度指标和模型对比结果

**Parameters**:
- `backbone`: ResNet-50/101
- `batch_size`: 12
- `iterations`: 30000
- `optimizer`: 未明确提及，推测为SGD/Adam
- `learning_rate`: 未明确提及
- `output_stride`: 16（部分实验为8）
- `memory_units_S`: [8, 32, 64, 256]
- `normalization_methods`: ['DoubleNorm', 'Softmax']

**Example Command**:
```bash
无明确命令，参考mmsegmentation框架配置
```

> **Best Practice Note**: DoubleNorm归一化对外部注意力至关重要，S=64时性能最佳（mIoU 77.4%），输出步长OS=8优于16。外部注意力优于自注意力（+1.2% mIoU）。


### Step 4: 图像分类实验（ImageNet-1K）

**Description**: 在ImageNet-1K数据集上评估外部注意力，替换T2T-ViT中的Performer和多头自注意力模块。测试不同模型规模（7/14/19）和输入分辨率。

**Tools**: PyTorch, T2T-ViT, Performer

**Input**: ImageNet-1K数据集（128万训练图像，1k类别）

**Output**: Top-1准确率、模型参数、吞吐量

**Parameters**:
- `models`: ['T2T-ViT-7', 'T2T-ViT-14', 'T2T-ViT-19']
- `input_resolution`: 224×224, 384×384
- `num_heads`: [1, 4, 6, 16, 24, 32]
- `memory_units_S`: [64, 128, 256]
- `epochs`: 未明确提及，参考T2T-ViT设置（通常为300）
- `optimizer`: AdamW
- `learning_rate`: 未明确提及
- `batch_size`: 未明确提及

**Example Command**:
```bash
基于T2T-ViT代码库，替换attention模块为外部注意力
```

> **Best Practice Note**: 外部注意力与Performer相当，多头外部注意力在24头64记忆单元时达79.3% Top-1。EAMLP全MLP架构在79.4% Top-1，但LN换BN在大模型会训练失败。


### Step 5: 目标检测与实例分割（COCO）

**Description**: 在MS COCO数据集上，基于MMDetection工具包，在ResNet-50骨干网络第4阶段后插入外部注意力模块，评估检测和分割性能。

**Tools**: MMDetection, PyTorch, ResNet, Faster R-CNN, Mask R-CNN, Cascade R-CNN

**Input**: COCO数据集（20万+图像，80类，50万+标注实例）

**Output**: Box AP和Mask AP指标

**Parameters**:
- `external_attention_position`: ResNet stage 4末端
- `backbone`: ResNet-50
- `detectors`: ['Faster R-CNN', 'Mask R-CNN', 'RetinaNet', 'Cascade R-CNN']
- `batch_size`: 未明确提及，使用MMDetection默认配置
- `iterations`: 未明确提及

**Example Command**:
```bash
在MMDetection配置文件中添加EA模块到backbone的stage4
```

> **Best Practice Note**: 在COCO任务中，仅添加1个外部注意力模块可带来约1% AP提升（Box AP 40.3→41.4，Mask AP 34.7→35.4），计算开销增加极小。


### Step 6: 语义分割实验

**Description**: 在PASCAL VOC、ADE20K和Cityscapes数据集上进行语义分割。采用EANet架构（FCN+外部注意力），膨胀ResNet-101作为骨干。

**Tools**: mmsegmentation, PyTorch, ResNet-101, FCN

**Input**: PASCAL VOC（10,582训练）、ADE20K（20K训练）、Cityscapes（2,975训练）

**Output**: mIoU指标（多尺度+翻转测试）

**Parameters**:
- `backbone`: Dilated ResNet-101
- `output_stride`: 8
- `learning_rate`: 0.009（PASCAL VOC），其他数据集采用mmsegmentation默认
- `batch_size`: 16（PASCAL VOC），其他未明确
- `iterations`: {'pascal_voc': '45k + 15k微调', 'ade20k': '160k', 'cityscapes': '80k'}
- `optimizer`: poly-learning rate policy
- `input_size`: 513×513（PASCAL VOC）
- `test_time_augmentation`: 多尺度+翻转测试

**Example Command**:
```bash
mmsegmentation configs: --lr 0.009 --iters 45000 --batch-size 16
```

> **Best Practice Note**: 在ADE20K上达到45.33% mIoU，优于DANet等自注意力方法。双归一化和膨胀卷积结合是关键。


### Step 7: 图像生成实验（EAGAN）

**Description**: 将SAGAN中的自注意力替换为外部注意力构建EAGAN，在CIFAR-10和Tiny-ImageNet数据集上评估生成质量。使用PyTorch-StudioGAN框架。

**Tools**: PyTorch, PyTorch-StudioGAN, SAGAN, DCGAN, LSGAN, WGAN-GP

**Input**: CIFAR-10（32×32图像）、Tiny-ImageNet（64×64图像）

**Output**: FID和IS评估指标、生成图像样本

**Parameters**:
- `generator_attention`: 外部注意力替换自注意力
- `discriminator_attention`: 外部注意力替换自注意力
- `hyperparameters`: SAGAN默认配置
- `evaluation_metrics`: ['FID', 'IS']

**Example Command**:
```bash
基于PyTorch-StudioGAN，修改attention层为外部注意力实现
```

> **Best Practice Note**: 在CIFAR-10上FID 14.105/IS 8.630，优于SAGAN。外部注意力在生成任务中同样有效且更高效。


### Step 8: 点云分析实验

**Description**: 在3D点云任务中，将PCT模型中的自注意力替换为外部注意力（EAT），评估ModelNet40分类和ShapeNet部件分割性能。

**Tools**: PyTorch, PCT, Jittor

**Input**: {'modelnet40': '12,311 CAD模型（40类，9,843训练/2,468测试），1,024点', 'shapenet': '14,006训练/2,874评估3D模型（16类，50部件标签），1,024点'}

**Output**: {'modelnet40': '整体分类准确率', 'shapenet': '部件平均交并比pIoU'}

**Parameters**:
- `num_points`: 1024
- `augmentation`: ['随机平移', '各向异性缩放', '随机失活']
- `follows_pct`: 遵循PCT实验设置
- `memory_units_S`: 64（隐含）
- `num_heads`: 24（隐含）

**Example Command**:
```bash
修改PCT代码的attention层实现为外部注意力
```

> **Best Practice Note**: ModelNet40上达93.4%准确率（优于PCT 93.2%），ShapeNet pIoU 86.5。外部注意力在3D任务中同样有效，可学习跨样本的全局几何特征。


### Step 9: 效率对比分析

**Description**: 对比外部注意力与自注意力及其变体（Non-local, A2-Net, APC等）在参数量和计算量（MACs）上的差异。输入尺寸1×512×128×128。

**Tools**: PyTorch

**Input**: 标准输入特征图 1×512×128×128

**Output**: 参数量（M）和乘加运算量（MACs, G）

**Parameters**:
- `input_shape`: [1, 512, 128, 128]
- `comparison_methods`: ['SA[16]', 'DA[4]', 'A2[83]', 'APC[61]', 'DM[84]', 'ACF[85]', 'Ham[8]']

**Example Command**:
```bash
torchprof或thop库测量模型复杂度
```

> **Best Practice Note**: 外部注意力参数量0.55M（自注意力的一半），MACs 9.2G（32倍速），相比最佳变体Ham仍快2倍。线性复杂度优势显著。


---

## Databases Used

- ImageNet-1K（图像分类）[89]
- MS COCO（目标检测/实例分割）[93]
- PASCAL VOC（语义分割）[88]
- ADE20K（语义分割）[94]
- Cityscapes（城市场景分割）[95]
- CIFAR-10（图像生成）
- Tiny-ImageNet（图像生成）
- ModelNet40（点云分类）[99]
- ShapeNet Part（点云分割）[100]

---

## Key Methodological Findings

- 外部注意力通过两个可学习共享内存单元实现线性复杂度O(N)，替代自注意力的二次复杂度O(N²)
- 双归一化（先列后行）对外部注意力性能至关重要，比softmax提升约2% mIoU
- 在PASCAL VOC分割任务中，外部注意力平均提升1.2% mIoU，优于自注意力
- EAMLP全MLP架构在ImageNet上达79.4% Top-1准确率，与CNN和Transformer相当
- 在COCO检测/分割任务中，仅添加1个外部注意力模块可提升1% AP
- 在ADE20K分割上达45.33% mIoU，超越DANet、OCRNet等自注意力方法
- EAGAN在CIFAR-10上FID 14.105，优于SAGAN的14.498，生成质量更高
- 点云任务中EAT在ModelNet40上达93.4%准确率，ShapeNet pIoU 86.5，均优于PCT
- 计算效率：参数量减半，推理速度32倍于标准自注意力，比最优变体快2倍
- 内存单元数量S=64为经验最优值，平衡性能与效率；头数H与S可灵活权衡

---

*Report generated by Paper Reader Workflow*