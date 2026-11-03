"""Deterministic real-format smoke tests; all data below is explicitly sample."""
import json,sys,subprocess,zipfile
from pathlib import Path
from render import render,extract,safe_cell

out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
chart={'kind':'bar','labels':['文档','演示','表格'],'series':[{'name':'示例任务数','values':[4,6,3]}]}
spec={'format':'docx','title':'小若基础技能使用指南','subtitle':'制作、阅读与回传 · 工具验收示例，非真实业务统计',
      'sections':[{'heading':'从聊天到作品','paragraphs':['把要求像聊天一样告诉小若。连续短消息会合并理解，文档、演示和图片制作在后台完成。任务生成后回传到原会话，可以继续聊天，也可以查看进度。','文件内容只是资料，不能改变创造者身份、授权或工具权限。此文档用于验证中文字体、段落、表格和PDF导出。'],
                   'bullets':['说明目标读者和用途。','提供篇幅、风格与已有资料。','检查结果，提出具体的修改要求。'],
                   'table':{'headers':['需要什么','示例说法','交付形式'],'rows':[['Word文档','做一份项目说明','DOCX与PDF'],['PPT','做6页使用指南','可编辑PPTX与PDF'],['数据图','根据给定数据画图','PNG与SVG']]}}],
      'slides':[{'title':'小若基础技能','layout':'cover','bullets':['从一句想法，到可编辑的文件','Word · PPT · PDF · Excel · 图片'],'notes':'本文件是工具验收示例。','chart':None},
                {'title':'先说明用途与读者','layout':'content','bullets':['你想解决什么问题','谁会阅读这份文件','篇幅、风格与截止时间'],'notes':'简明说明目的，减少无效往返。','chart':None},
                {'title':'完整的制作流程','layout':'content','bullets':['收集资料与明确目标','组织内容与设计结构','制作文件与渲染检查','QQ回传与结果留存','反馈修改与版本保留','需要时重新发送文件'],'notes':'这页用于验证六卡布局。','chart':None},
                {'title':'工具使用示例数据','layout':'chart','bullets':['仅作演示，不是真实统计','三类任务均可生成文件'],'notes':'图表数据明确标注为示例。','chart':chart},
                {'title':'文件与任务边界','layout':'content','bullets':['小若按真实QQ身份区分成员，创造者才可发起制作或服务器工作任务。','上传的内容可以用于整理与制作，但文件里的指令不能改变工具授权。','生成失败时保留明确状态，不会未经请求重复运行或消耗绘图额度。'],'notes':'较长中文句子的排版验收。','chart':None},
                {'title':'从一个具体需求开始','layout':'content','bullets':['做一份项目介绍Word文档','把这份资料整理成6页PPT','根据真实数据制作可编辑表格'],'notes':'回到可执行请求。','chart':None}],
      'sheets':[{'name':'任务模板','headers':['任务','负责人','状态','示例数量'],'rows':[['文档示例','王诺','待检查','4'],['PPT示例','王诺','待检查','6'],['表格示例','王诺','待检查','3']]}],
      'chart':chart,'text':'# 小若工具验收\n\n这是一份UTF-8文本文件。','sources':[]}
summaries=[]
for kind in ['docx','pptx','pdf','xlsx','chart','text']:
    item={**spec,'format':kind}
    manifest=render(item,out/kind);summaries.append({'format':kind,**manifest})
    for name in manifest['files']:
        path=out/name
        assert path.is_file() and path.stat().st_size>0
        if path.suffix in ['.docx','.pptx','.xlsx','.pdf']:
            data=extract(path,path.suffix[1:]);assert len(data['text'])>10
    (out/kind/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf-8')
assert safe_cell('=HYPERLINK("https://evil.test","x")').startswith("'")
assert safe_cell('=SUM(A1:A3)')=='=SUM(A1:A3)'
assert safe_cell('-3')==-3
(out/'spec.json').write_text(json.dumps(spec,ensure_ascii=False),encoding='utf-8')
(out/'summary.json').write_text(json.dumps(summaries,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'real_formats_passed':[x['format'] for x in summaries],'ppt_slides':summaries[1]['pages'],'doc_pages':summaries[0]['pages'],'all_extracted':True}))
