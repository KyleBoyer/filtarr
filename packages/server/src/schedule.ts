import { Cron, CronPattern } from 'croner';
function localParts(date: Date, timezone: string) {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).formatToParts(date);
  return {hour:Number(parts.find(p=>p.type==='hour')?.value),minute:Number(parts.find(p=>p.type==='minute')?.value)};
}
/** Croner advances a missing DST hour into the next valid hour. Filtarr skips that occurrence. */
export function nextScheduleRun(expression: string, timezone: string, after: Date = new Date()): Date | null {
  const cron=new Cron(expression,{timezone});
  const pattern=new CronPattern(expression,timezone);
  let cursor=after;
  for(let i=0;i<1000;i++){
    const candidate=cron.nextRun(cursor);if(!candidate)return null;
    const local=localParts(candidate,timezone);
    if(pattern.hour[local.hour]===1&&pattern.minute[local.minute]===1)return candidate;
    cursor=candidate;
  }
  throw Error('Could not find a valid schedule occurrence');
}
