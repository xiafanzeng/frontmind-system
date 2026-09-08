#!/usr/bin/env python3
"""Provision private CN analytics; all credentials stay in root-only host files."""
import json, secrets, time, urllib.request, urllib.error
from pathlib import Path
BASE = 'http://127.0.0.1:3010'
path = Path('/etc/frontmind-system/umami-admin.json')
state = json.loads(path.read_text())
def save():
    path.write_text(json.dumps(state)); path.chmod(0o600)
def api(method, endpoint, body=None, token=None):
    headers = {'Content-Type':'application/json'}
    if token: headers['Authorization']='Bearer '+token
    req=urllib.request.Request(BASE+endpoint, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req,timeout=30) as response: return json.load(response)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{method} {endpoint}: HTTP {e.code}') from None
try:
    login=api('POST','/api/auth/login',{'username':state['username'],'password':state['password']})
except RuntimeError:
    if state.get('configuredAt'): raise
    initial=api('POST','/api/auth/login',{'username':'admin','password':'umami'})
    api('POST','/api/users/'+initial['user']['id'],{'username':state['username'],'password':state['password']},initial['token'])
    login=api('POST','/api/auth/login',{'username':state['username'],'password':state['password']})
token=login['token']
if not state.get('teamId'):
    teams=api('GET','/api/teams',token=token).get('data',[])
    team=next((item for item in teams if item.get('name')=='FrontMind CN Website'),None)
    if team is None:
        result=api('POST','/api/teams',{'name':'FrontMind CN Website'},token)
        team=result[0] if isinstance(result,list) else result
    state['teamId']=team['id'];save()
if not state.get('readerId'):
    user=api('POST','/api/users',{'username':state['readerUsername'],'password':state['readerPassword'],'role':'view-only'},token)
    state['readerId']=user['id'];save()
if not state.get('readerAssigned'):
    api('POST',f"/api/teams/{state['teamId']}/users",{'userId':state['readerId'],'role':'team-view-only'},token)
    state['readerAssigned']=True;save()
if not state.get('websiteId'):
    site=api('POST','/api/websites',{'name':'FrontMind CN Website','domain':'www.frontmind.cn','teamId':state['teamId']},token)
    state['websiteId']=site['id'];save()
reader=api('POST','/api/auth/login',{'username':state['readerUsername'],'password':state['readerPassword']})
end=int(time.time()*1000)
stats=api('GET',f"/api/websites/{state['websiteId']}/stats?startAt=0&endAt={end}",token=reader['token'])
newenv={
 'FRONTMIND_UMAMI_ORIGIN':'http://umami:3000',
 'FRONTMIND_UMAMI_WEBSITE_ID':state['websiteId'],
 'FRONTMIND_UMAMI_USERNAME':state['readerUsername'],
 'FRONTMIND_UMAMI_PASSWORD':state['readerPassword'],
 'FRONTMIND_VISITOR_STATS_LEGACY_FILE':'/var/lib/frontmind-website/visitor-stats-cn-legacy.json',
}
envpath=Path('/etc/frontmind-system/website.env')
lines=[line for line in envpath.read_text().splitlines() if line.split('=',1)[0] not in newenv]
envpath.write_text('\n'.join(lines+[f'{k}={v}' for k,v in newenv.items()])+'\n');envpath.chmod(0o600)
state['configuredAt']=state.get('configuredAt') or time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());save()
print(json.dumps({'websiteId':state['websiteId'],'readerRole':'team-view-only','statsReadable':True,'pageviews':stats.get('pageviews'),'management':'loopback-only'}))
