# 检验记录表

一个基于 HTML/CSS/JS 的检验记录管理系统，运行在浏览器端，数据存储在 localStorage 中。

## 功能特性

- 📝 **检验数据录入** — 录入客户、生产订单、物料编码、图号、数量、不合格信息
- 📦 **物料库管理** — 维护物料编码、图号、客户的关联关系，支持批量导入/导出 Excel
- 🔍 **智能匹配** — 输入物料编码或图号时自动匹配物料库，支持模糊搜索下拉提示
- 📜 **历史记录查询** — 按日期范围、客户、物料编码筛选历史记录，支持分页
- 📊 **汇总报表** — 按客户/物料/不合格原因维度生成质量汇总报表
- 💾 **数据备份恢复** — 一键导出/恢复全部数据（JSON 格式）
- 📥 **Excel 导出** — 导出当日检验记录和汇总报表为 Excel 文件

## 快速开始

直接用浏览器打开 `index.html` 即可使用。所有数据存储在浏览器 localStorage 中，无需服务器。

## 技术栈

- 纯 HTML/CSS/JavaScript，无框架依赖
- [SheetJS (xlsx)](https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js) — Excel 读写
- localStorage — 数据持久化

## 浏览器兼容

支持所有现代浏览器（Chrome、Firefox、Safari、Edge）。

## 许可证

MIT
