export const experienceAvailable = import.meta.env.DEV && ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
export const experienceMode = experienceAvailable && new URLSearchParams(location.search).get('experience') === '1';
export function experienceURL(enabled:boolean){const url=new URL(location.href);if(enabled)url.searchParams.set('experience','1');else url.searchParams.delete('experience');url.hash='wallet';return url.href;}
