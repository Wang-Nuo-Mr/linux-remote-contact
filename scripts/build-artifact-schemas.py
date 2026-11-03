import json
from pathlib import Path
root=Path(__file__).resolve().parent.parent
string={'type':'string'}
def array(item):return {'type':'array','items':item}
def obj(properties):return {'type':'object','additionalProperties':False,'required':list(properties),'properties':properties}
def nullable(value):return {'anyOf':[{'type':'null'},value]}
table=nullable(obj({'headers':array(string),'rows':array(array(string))}))
chart=nullable(obj({'kind':{'type':'string','enum':['bar','line','pie']},'labels':array(string),'series':array(obj({'name':string,'values':array({'type':'number'})}))}))
plan=obj({'title':string,'subtitle':string,'sections':array(obj({'heading':string,'paragraphs':array(string),'bullets':array(string),'table':table,'asset':{'type':['string','null']},'caption':string})),
          'slides':array(obj({'title':string,'layout':{'type':'string','enum':['cover','content','chart','photo']},'bullets':array(string),'notes':string,'chart':chart,'asset':{'type':['string','null']}})),
          'sheets':array(obj({'name':string,'headers':array(string),'rows':array(array(string))})),
          'chart':chart,'text':string,'sources':array(obj({'title':string,'url':string}))})
(root/'config/artifact-schema.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
p=root/'config/chat-schema.json';chat=json.loads(p.read_text(encoding='utf-8'))
chat['properties']['artifact']=nullable(obj({'format':{'type':'string','enum':['docx','pptx','pdf','xlsx','image','chart','text']},'request':string,'sourceId':{'type':['string','null']}}))
if 'artifact' not in chat['required']:chat['required'].append('artifact')
chat['properties']['fileAction']=nullable(obj({'type':{'type':'string','enum':['status','list','resend']},'resultId':{'type':['string','null']},'name':{'type':['string','null']}}))
if 'fileAction' not in chat['required']:chat['required'].append('fileAction')
if 'group_message' not in chat['properties']['action']['anyOf'][1]['properties']['type']['enum']:chat['properties']['action']['anyOf'][1]['properties']['type']['enum'].append('group_message')
p.write_text(json.dumps(chat,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
