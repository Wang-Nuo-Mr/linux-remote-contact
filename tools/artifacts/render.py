"""Bounded JSON-to-artifact renderer. No model-generated code is executed."""
import csv,json,math,os,re,subprocess,sys,tempfile,zipfile
from pathlib import Path

FONT='Noto Sans CJK SC'
NAVY='122438';TEAL='087E8B';INK='203347';MUTED='657789';PALE='F0F6F8'

def text(value,limit=2000):
    if not isinstance(value,str) or len(value)>limit:raise ValueError('invalid_text_length')
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]','',value)
def seq(value,maximum):
    if not isinstance(value,list) or len(value)>maximum:raise ValueError('invalid_item_count')
    return value
def filename(value):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]','_',value).strip(' .')[:48] or '小若作品'
def office_pdf(source,directory):
    with tempfile.TemporaryDirectory(prefix='contact-office-') as profile:
        completed=subprocess.run(['libreoffice','-env:UserInstallation='+Path(profile).as_uri(),'--headless','--convert-to','pdf','--outdir',str(directory),str(source)],capture_output=True,timeout=90)
    output=directory/(source.stem+'.pdf')
    if completed.returncode or not output.exists() or not output.read_bytes().startswith(b'%PDF-'):raise ValueError('office_pdf_failed')
    return output
def preview(pdf,directory):
    from pypdf import PdfReader
    reader=PdfReader(pdf)
    if not 1<=len(reader.pages)<=80:raise ValueError('page_count_outside_limit')
    prefix=directory/'预览'
    completed=subprocess.run(['pdftoppm','-f','1','-singlefile','-scale-to','1400','-png',str(pdf),str(prefix)],capture_output=True,timeout=30)
    if completed.returncode or not prefix.with_suffix('.png').exists():raise ValueError('preview_failed')
    return prefix.with_suffix('.png'),len(reader.pages)
def table_data(table):
    if table is None:return None
    headers=[text(x,100) for x in seq(table['headers'],8)]
    if not headers:raise ValueError('table_headers_empty')
    rows=[[text(str(x),500) for x in seq(row,len(headers))] for row in seq(table['rows'],60)]
    if any(len(row)!=len(headers) for row in rows):raise ValueError('table_width_mismatch')
    return headers,rows
def chart_data(chart):
    if chart is None:return None
    labels=[text(x,40) for x in seq(chart['labels'],20)]
    series=[]
    for item in seq(chart['series'],4):
        values=seq(item['values'],len(labels))
        if len(values)!=len(labels) or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or abs(v)>1e15 for v in values):raise ValueError('invalid_chart_values')
        series.append((text(item['name'],60),values))
    if not labels or not series:raise ValueError('empty_chart')
    kind=chart['kind']
    if kind not in ['bar','line','pie']:raise ValueError('chart_kind')
    if kind=='pie' and (any(v<0 for v in series[0][1]) or sum(series[0][1])<=0):raise ValueError('pie_values')
    return kind,labels,series
def asset_file(spec,name):
    if not name:return None
    if not isinstance(name,str) or not re.fullmatch(r'[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)',name,re.I):raise ValueError('invalid_asset_name')
    root=Path(spec['_input_root']);source=root/name
    if root.is_symlink() or source.is_symlink() or source.resolve().parent!=root.resolve() or not source.is_file() or source.stat().st_size>8*1024*1024:raise ValueError('invalid_asset_file')
    from PIL import Image
    folder=root.parent/'.qa'/'assets';folder.mkdir(parents=True,exist_ok=True);target=folder/(source.stem+'.png')
    with Image.open(source) as image:
        if image.width*image.height>40000000:raise ValueError('asset_dimensions')
        image.convert('RGBA' if 'A' in image.getbands() or 'transparency' in image.info else 'RGB').save(target)
    return target
def make_doc(spec,path):
    from docx import Document
    from docx.shared import Cm,Pt,RGBColor
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    doc=Document();section=doc.sections[0]
    section.page_width=Cm(21);section.page_height=Cm(29.7)
    section.top_margin=Cm(2.1);section.bottom_margin=Cm(2);section.left_margin=Cm(2.3);section.right_margin=Cm(2.3)
    for name in ['Normal','Title','Subtitle','Heading 1','Heading 2','List Bullet']:
        style=doc.styles[name];style.font.name=FONT;style.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),FONT)
    normal=doc.styles['Normal'];normal.font.size=Pt(11);normal.font.color.rgb=RGBColor.from_string(INK)
    normal.paragraph_format.space_after=Pt(7);normal.paragraph_format.line_spacing=1.4
    for name,size in [('Title',28),('Heading 1',17),('Heading 2',13)]:
        doc.styles[name].font.size=Pt(size);doc.styles[name].font.color.rgb=RGBColor.from_string(NAVY)
        doc.styles[name].paragraph_format.keep_with_next=True
    doc.add_heading(text(spec['title'],120),0)
    if spec['subtitle']:doc.add_paragraph(text(spec['subtitle'],300),'Subtitle')
    for item in seq(spec['sections'],40):
        doc.add_heading(text(item['heading'],120),1)
        for paragraph in seq(item['paragraphs'],20):doc.add_paragraph(text(paragraph,2400))
        for bullet in seq(item['bullets'],12):doc.add_paragraph(text(bullet,600),'List Bullet')
        asset=asset_file(spec,item.get('asset'))
        if asset:
            from PIL import Image
            with Image.open(asset) as image:width,height=image.size
            scale=min(15/width,8/height)
            paragraph=doc.add_paragraph();paragraph.alignment=1;paragraph.add_run().add_picture(str(asset),width=Cm(width*scale),height=Cm(height*scale))
            if item.get('caption'):doc.add_paragraph(text(item['caption'],300),'Caption')
        data=table_data(item['table'])
        if data:
            headers,rows=data;table=doc.add_table(rows=1,cols=len(headers));table.style='Light Shading Accent 1'
            for cell,value in zip(table.rows[0].cells,headers):cell.text=value
            props=table.rows[0]._tr.get_or_add_trPr();repeat=OxmlElement('w:tblHeader');props.append(repeat)
            for row in rows:
                for cell,value in zip(table.add_row().cells,row):cell.text=value
            for row in table.rows:
                cant_split=OxmlElement('w:cantSplit');row._tr.get_or_add_trPr().append(cant_split)
            spacer=doc.add_paragraph();spacer.paragraph_format.space_after=Pt(0);spacer.paragraph_format.line_spacing=Pt(1)
    if spec['sources']:
        doc.add_heading('参考资料',1)
        for item in seq(spec['sources'],15):doc.add_paragraph(text(item['title'],200)+' '+text(item['url'],1000))
    footer=section.footer.paragraphs[0];footer.alignment=2
    footer.add_run('小若 · ')
    field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');footer._p.append(field)
    doc.core_properties.title=spec['title'];doc.core_properties.author='小若'
    doc.save(path)
def make_ppt(spec,path):
    from pptx import Presentation
    from pptx.util import Inches,Pt
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE,XL_LEGEND_POSITION
    prs=Presentation();prs.slide_width=Inches(13.333);prs.slide_height=Inches(7.5)
    def box(slide,x,y,w,h,value,size=24,color=INK,bold=False,fill=None):
        shape=slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,Inches(x),Inches(y),Inches(w),Inches(h)) if fill else slide.shapes.add_textbox(Inches(x),Inches(y),Inches(w),Inches(h))
        if fill:shape.fill.solid();shape.fill.fore_color.rgb=RGBColor.from_string(fill);shape.line.fill.background()
        tf=shape.text_frame;tf.clear();tf.word_wrap=True;tf.margin_left=Inches(.12);tf.margin_right=Inches(.12)
        p=tf.paragraphs[0];p.text=value;p.font.name=FONT;p.font.size=Pt(size);p.font.bold=bold;p.font.color.rgb=RGBColor.from_string(color)
        return shape
    slides=[]
    for original in seq(spec['slides'],24):
        body=[text(x,200) for x in seq(original['bullets'],6)]
        # Preserve all copy: dense content continues onto another editable slide.
        body=[part for line in body for part in [line[i:i+85] for i in range(0,len(line),85)]]
        chart=original['chart'] is not None or bool(original.get('asset'))
        if chart and any(len(x)>30 for x in body):
            slides.append({**original,'bullets':[]});original={**original,'layout':'content','chart':None,'asset':None,'title':original['title']+' · 解读'};chart=False
        count=3 if original['layout']=='cover' or chart or any(len(x)>55 for x in body) else 6
        chunks=[body[i:i+count] for i in range(0,len(body),count)] or [[]]
        for i,chunk in enumerate(chunks):slides.append({**original,'bullets':chunk,'title':original['title']+(' · 续' if i else ''),'layout':original['layout'] if not i else 'content','chart':original['chart'] if not i else None,'asset':original.get('asset') if not i else None})
    if len(slides)>32:raise ValueError('expanded_slides_limit')
    if not slides:raise ValueError('slides_empty')
    for index,item in enumerate(slides):
        slide=prs.slides.add_slide(prs.slide_layouts[6]);cover=item['layout']=='cover'
        slide.background.fill.solid();slide.background.fill.fore_color.rgb=RGBColor.from_string(NAVY if cover else 'FAFCFD')
        title=text(item['title'],80);body=[text(x,200) for x in seq(item['bullets'],6)]
        if cover:
            box(slide,.8,1.1,11.7,.4,'XIAORUO / '+str(index+1).zfill(2),14,'67D7DB')
            box(slide,.8,2.1,11.7,1.65,title,34 if len(title)>26 else 38,'FFFFFF',True)
            box(slide,.8,4.3,10.8,1.6,'\n'.join(body[:3]),23,'D5E8ED')
            box(slide,.8,6.6,2,.08,'',fill=TEAL)
        else:
            box(slide,.65,.4,.1,.5,'',fill=TEAL)
            box(slide,.9,.35,11.7,1,title,30,NAVY,True)
            chart=chart_data(item['chart'])
            asset=asset_file(spec,item.get('asset'))
            if asset:
                from PIL import Image
                with Image.open(asset) as image:width,height=image.size
                scale=min(8.3/width,4.8/height);w=width*scale;h=height*scale
                slide.shapes.add_picture(str(asset),Inches(.9+(8.3-w)/2),Inches(1.7+(4.8-h)/2),width=Inches(w),height=Inches(h))
                for i,line in enumerate(body[:3]):box(slide,9.5,1.9+i*1.4,2.8,1.2,line,19)
            elif chart:
                kind,labels,series=chart;data=CategoryChartData();data.categories=labels
                for name,values in series:data.add_series(name,values)
                graph=slide.shapes.add_chart({'bar':XL_CHART_TYPE.COLUMN_CLUSTERED,'line':XL_CHART_TYPE.LINE_MARKERS,'pie':XL_CHART_TYPE.PIE}[kind],Inches(.9),Inches(1.7),Inches(8.3),Inches(4.8),data).chart
                graph.has_legend=True;graph.legend.position=XL_LEGEND_POSITION.BOTTOM
                graph.legend.font.name=FONT;graph.legend.font.size=Pt(13)
                for i,line in enumerate(body[:3]):box(slide,9.5,1.9+i*1.4,2.8,1.2,line,19)
            elif len(body)<=3 and all(len(line)<=100 for line in body):
                for i,line in enumerate(body):
                    box(slide,.9,1.65+i*1.6,11.5,1.45,line,22 if len(line)>55 else 25,INK,False,PALE)
            else:
                for i,line in enumerate(body):
                    column=i//3;row=i%3
                    box(slide,.9+column*5.9,1.65+row*1.6,5.55,1.45,line,21,INK,False,PALE)
            box(slide,.9,7.0,10,.25,spec['title'][:70],10,MUTED)
            box(slide,12.0,7.0,.5,.25,str(index+1).zfill(2),11,TEAL)
        slide.notes_slide.notes_text_frame.text=text(item['notes'],4000)
    prs.core_properties.title=spec['title'];prs.core_properties.author='小若';prs.save(path)
def safe_cell(value):
    value=text(str(value),2000)
    if re.fullmatch(r'-?(?:0|[1-9]\d{0,12})(?:\.\d{1,8})?',value):return float(value) if '.' in value else int(value)
    if value.startswith('=') and re.fullmatch(r'=(SUM|AVERAGE|MIN|MAX|COUNT)\([A-Z]{1,3}[1-9]\d{0,4}(?::[A-Z]{1,3}[1-9]\d{0,4})?\)',value):return value
    return "'"+value if value.startswith(('=','+','-','@')) else value
def make_xlsx(spec,path):
    from openpyxl import Workbook
    from openpyxl.styles import Font,PatternFill,Alignment
    wb=Workbook();wb.remove(wb.active);seen=set()
    for item in seq(spec['sheets'],6):
        name=re.sub(r'[\\/*?:\[\]]','_',text(item['name'],31)) or 'Sheet'
        if name.lower() in seen:raise ValueError('duplicate_sheet_name')
        seen.add(name.lower());ws=wb.create_sheet(name)
        headers=[text(x,100) for x in seq(item['headers'],20)]
        if not headers:raise ValueError('empty_sheet')
        ws.append(["'"+x if x.startswith(('=','+','-','@')) else x for x in headers])
        rows=seq(item['rows'],2000)
        for row in rows:
            if len(row)!=len(headers):raise ValueError('sheet_width_mismatch')
            ws.append([safe_cell(x) for x in row])
        for cell in ws[1]:cell.font=Font(name=FONT,bold=True,color='FFFFFF');cell.fill=PatternFill('solid',fgColor=NAVY)
        for row in ws.iter_rows(min_row=2):
            for cell in row:cell.font=Font(name=FONT,size=11);cell.alignment=Alignment(wrap_text=True,vertical='top')
        ws.freeze_panes='A2';ws.auto_filter.ref=ws.dimensions
        for column in ws.columns:
            letter=column[0].column_letter;ws.column_dimensions[letter].width=min(48,max(14,max(len(str(c.value or '')) for c in list(column)[:80])*1.3))
        ws.sheet_properties.pageSetUpPr.fitToPage=True
        ws.page_setup.orientation='landscape';ws.page_setup.paperSize=ws.PAPERSIZE_A4;ws.page_setup.fitToWidth=1;ws.page_setup.fitToHeight=0
        with path.with_name(path.stem+'-'+filename(name)+'.csv').open('w',encoding='utf-8-sig',newline='') as stream:
            writer=csv.writer(stream);writer.writerow(["'"+x if x.startswith(('=','+','-','@')) else x for x in headers])
            for row in rows:
                values=[safe_cell(x) for x in row]
                writer.writerow(["'"+v if isinstance(v,str) and v.startswith('=') else v for v in values])
    if not wb.worksheets:raise ValueError('sheets_empty')
    wb.save(path)
def make_chart(spec,path):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.font_manager import FontProperties
    font=FontProperties(fname='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
    kind,labels,series=chart_data(spec['chart'])
    fig,ax=plt.subplots(figsize=(11,6.5),dpi=180);fig.patch.set_facecolor('#FAFCFD');ax.set_facecolor('#FAFCFD')
    colors=['#087E8B','#F18F01','#A044BD','#2878B5']
    if kind=='pie':
        ax.pie(series[0][1],labels=labels,autopct='%1.1f%%',textprops={'fontproperties':font},colors=colors)
    else:
        for index,(name,values) in enumerate(series):
            if kind=='bar':ax.bar([x+(index-(len(series)-1)/2)*.8/len(series) for x in range(len(labels))],values,width=.8/len(series),label=name,color=colors[index])
            else:ax.plot(range(len(labels)),values,'o-',label=name,color=colors[index],linewidth=2.5)
        ax.set_xticks(range(len(labels)),labels,fontproperties=font,rotation=20 if len(labels)>8 else 0)
        ax.grid(axis='y',alpha=.2);ax.set_axisbelow(True);ax.legend(prop=font,frameon=False)
        ax.spines[['top','right']].set_visible(False)
    ax.set_title(text(spec['title'],120),fontproperties=font,fontsize=22,pad=22)
    fig.tight_layout();fig.savefig(path,bbox_inches='tight');fig.savefig(path.with_suffix('.svg'),bbox_inches='tight');plt.close(fig)
def verify_office(path):
    with zipfile.ZipFile(path) as archive:
        if archive.testzip():raise ValueError('corrupt_office_archive')
        names=archive.namelist()
        if '[Content_Types].xml' not in names or any('vbaProject' in name for name in names):raise ValueError('invalid_office_package')
def render(spec,out):
    from PIL import Image
    out.mkdir(parents=True,exist_ok=True);title=text(spec['title'],120);stem=filename(title);kind=spec['format'];pages=None
    os.environ['MPLCONFIGDIR']=str(out/'.qa'/'matplotlib')
    if kind in ['docx','pdf']:
        source=out/(stem+'.docx');make_doc(spec,source);verify_office(source);pdf=office_pdf(source,out);cover,pages=preview(pdf,out)
        files=[source,pdf] if kind=='docx' else [pdf,source]
    elif kind=='pptx':
        source=out/(stem+'.pptx');make_ppt(spec,source);verify_office(source);pdf=office_pdf(source,out);cover,pages=preview(pdf,out);files=[source,pdf]
    elif kind=='xlsx':
        source=out/(stem+'.xlsx');make_xlsx(spec,source);verify_office(source);files=[source]+sorted(out.glob('*.csv'));cover=None
    elif kind=='chart':
        cover=out/(stem+'.png');make_chart(spec,cover);files=[cover,out/(stem+'.svg')]
    elif kind=='text':
        source=out/(stem+'.md');source.write_text(text(spec['text'],60000),encoding='utf-8');files=[source];cover=None
    else:raise ValueError('unsupported_format')
    for file in files:
        if not file.is_file() or not 0<file.stat().st_size<=20*1024*1024:raise ValueError('artifact_size_limit')
    if cover:
        with Image.open(cover) as image:image.verify()
    return {'files':[str(p.relative_to(out.parent)) for p in files],'preview':str(cover.relative_to(out.parent)) if cover else None,'pages':pages,'validated':True}
def safe_zip(path):
    with zipfile.ZipFile(path) as archive:
        items=archive.infolist()
        if len(items)>2000 or sum(x.file_size for x in items)>60*1024*1024 or any(x.file_size>20*1024*1024 for x in items):raise ValueError('input_archive_limit')
def extract(path,extension):
    parts=[]
    if extension in ['docx','pptx','xlsx']:safe_zip(path)
    if extension in ['txt','md','csv','json']:
        raw=path.read_bytes()
        try:value=raw.decode('utf-8-sig')
        except UnicodeDecodeError:value=raw.decode('gb18030')
        parts=[value]
    elif extension=='docx':
        from docx import Document
        document=Document(path);parts=[p.text for p in document.paragraphs]
        for table in document.tables:
            parts.extend(' | '.join(cell.text for cell in row.cells) for row in table.rows)
    elif extension=='pptx':
        from pptx import Presentation
        for index,slide in enumerate(Presentation(path).slides):
            parts.append('幻灯片 '+str(index+1))
            parts.extend(shape.text for shape in slide.shapes if shape.has_text_frame)
    elif extension=='xlsx':
        from openpyxl import load_workbook
        workbook=load_workbook(path,read_only=True,data_only=True,keep_links=False)
        for sheet in workbook:
            parts.append('工作表 '+sheet.title)
            for row in sheet.iter_rows(max_row=500,max_col=20,values_only=True):parts.append(' | '.join(str(x or '') for x in row))
        workbook.close()
    elif extension=='pdf':
        from pypdf import PdfReader
        reader=PdfReader(path)
        if reader.is_encrypted:raise ValueError('encrypted_pdf')
        parts=[(page.extract_text() or '') for page in list(reader.pages)[:40]]
    else:raise ValueError('unsupported_input_format')
    result='\n'.join(parts)
    return {'text':result[:60000],'truncated':len(result)>60000,'scanMayNeedOCR':extension=='pdf' and len(result.strip())<20}
def main():
    mode=sys.argv[1]
    if mode=='render':
        source=Path(sys.argv[2]);raw=source.read_bytes()
        if len(raw)>1000000:raise ValueError('spec_too_large')
        spec=json.loads(raw);spec['_input_root']=str(source.parent/'inputs')
        print(json.dumps(render(spec,Path(sys.argv[3])),ensure_ascii=False))
    elif mode=='validate-image':
        from PIL import Image
        path=Path(sys.argv[2])
        if path.stat().st_size>20*1024*1024:raise ValueError('image_size')
        with Image.open(path) as image:
            if image.width*image.height>40000000 or image.format not in ['PNG','JPEG','WEBP']:raise ValueError('image_format')
            image.verify()
        print('{"validated":true}')
    elif mode=='extract':
        path=Path(sys.argv[2])
        if path.stat().st_size>10*1024*1024:raise ValueError('input_too_large')
        output=Path(sys.argv[4]);output.write_text(json.dumps(extract(path,sys.argv[3]),ensure_ascii=False),encoding='utf-8');print('{"extracted":true}')
    else:raise ValueError('unsupported_mode')
if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'ok':False,'error':str(error) if isinstance(error,ValueError) else type(error).__name__}));sys.exit(1)
