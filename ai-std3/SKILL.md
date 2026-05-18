# ai-std3 — 独立全量流水线 Skill

ai-std3 是一个**自包含全量流水线 Skill**，从需求初始化到部署上线全链路自动化，不依赖 ai-prd3 / ai-auto3 / ai-design3 / ai-code3 / ai-publish-dev3 等其他 skill 脚本。

## 触发词

当用户说「ai-std3」「/ai-std3」「全量流水线」「std3 流水线」「run std3」「运行 std3」或要求执行 setup/prd/codegen/deploy 等阶段时使用。

## 流水线阶段链

```
setup → prd → prd-review → design → design-review
→ create-ui-scenarios → codegen → code-review
→ merge_push → build → deploy → ui_e2e → report
```

## 调用方式

```bash
# 启动完整流水线
node ai-std3/scripts/run-pipeline.cjs --project=<业务项目根路径>

# 单独运行某阶段（如首次 setup）
node ai-std3/scripts/stages/setup.cjs --project=<业务项目根路径>

# 从某阶段续跑
node ai-std3/scripts/run-pipeline.cjs --project=<路径> --from-stage=setup

# 查看流水线状态看板
node ai-std3/scripts/run-dash.cjs --project=<路径>
```

## 技能根目录

`CURSOR_SKILLS_ROOT` 环境变量优先，默认 `~/.cursor/skills`。

## 规范文档

完整规范见 `docs/spec/std3/std3.md` 及各 stage 文档。
