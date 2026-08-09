// ============================================================
// functions/api/_astro.js
// 天体計算の共通モジュール（サーバ側）
// moonPos / sunPos / moonAge / sunT / refraction / calcParallax
// および幾何・整形ヘルパを集約。各 API 関数から import して使う。
// これらの計算式をブラウザから秘匿するのが目的。
// ============================================================

export function toJD(d){ return d.valueOf()/86400000 - 0.5 + 2440588; }

// 大気差（Saemundsson 1986）
export function refraction(altDeg){
  if(altDeg > 85) return 0;
  const HORIZON_BOUNDARY = -0.5739;
  const REF_AT_BOUNDARY  =  0.5739;
  if(altDeg <= HORIZON_BOUNDARY) return REF_AT_BOUNDARY;
  const a = altDeg + 10.3/(altDeg + 5.11);
  return Math.max(0, 1.02/(Math.tan(a*Math.PI/180)*60));
}

// 地心視差補正（Meeus Ch.40）
export function calcParallax(H_deg, dec_deg, dist_km, lat_deg){
  const r=Math.PI/180;
  const H=H_deg*r, dec=dec_deg*r, lat=lat_deg*r;
  const sinPi=6378.14/dist_km;
  const u=Math.atan(0.99664719*Math.tan(lat));
  const rho_sin=0.99664719*Math.sin(u);
  const rho_cos=Math.cos(u);
  const numH=-rho_cos*sinPi*Math.sin(H);
  const denH=Math.cos(dec)-rho_cos*sinPi*Math.cos(H);
  const dAlpha=Math.atan2(numH,denH);
  const dec_prime=Math.atan2(
    (Math.sin(dec)-rho_sin*sinPi)*Math.cos(dAlpha),
    Math.cos(dec)-rho_cos*sinPi*Math.cos(H)
  );
  const H_prime=H-dAlpha;
  const sinAlt_prime=Math.sin(lat)*Math.sin(dec_prime)+Math.cos(lat)*Math.cos(dec_prime)*Math.cos(H_prime);
  const alt_prime=Math.asin(Math.max(-1,Math.min(1,sinAlt_prime)))/r;
  const az_prime=((Math.atan2(Math.sin(H_prime),Math.cos(H_prime)*Math.sin(lat)-Math.tan(dec_prime)*Math.cos(lat))/r)+180)%360;
  const sinAlt_geo=Math.sin(lat)*Math.sin(dec)+Math.cos(lat)*Math.cos(dec)*Math.cos(H);
  const alt_geo=Math.asin(Math.max(-1,Math.min(1,sinAlt_geo)))/r;
  const az_geo=((Math.atan2(Math.sin(H),Math.cos(H)*Math.sin(lat)-Math.tan(dec)*Math.cos(lat))/r)+180)%360;
  return{dAz:az_prime-az_geo, dAlt:alt_prime-alt_geo};
}

// 月位置（Meeus Ch.47 ＋ 視差 ＋ 屈折）
export function moonPos(date,lat,lng){
  const JD=toJD(date);
  const T=(JD-2451545)/36525;
  const D=(297.8501921+445267.1114034*T-0.0018819*T*T+T*T*T/545868)*Math.PI/180;
  const M=(357.5291092+35999.0502909*T-0.0001536*T*T)*Math.PI/180;
  const Mp=(134.9633964+477198.8675055*T+0.0087414*T*T+T*T*T/69699)*Math.PI/180;
  const F=(93.2720950+483202.0175233*T-0.0036539*T*T)*Math.PI/180;
  const E=1-0.002516*T-0.0000074*T*T;
  const lTerms=[
    [6288774,0,0,1,0],[1274027,2,0,-1,0],[658314,2,0,0,0],[213618,0,0,2,0],
    [-185116,0,1,0,0],[-114332,0,0,0,2],[58793,2,0,-2,0],[57066,2,-1,-1,0],
    [53322,2,0,1,0],[45758,2,-1,0,0],[-40923,0,1,-1,0],[-34720,1,0,0,0],
    [-30383,0,1,1,0],[15327,2,0,0,-2],[-12528,0,0,1,2],[10980,0,0,1,-2],
    [10675,4,0,-1,0],[10034,0,0,3,0],[8548,4,0,-2,0],[-7888,2,1,-1,0],
    [-6766,2,1,0,0],[-5163,1,0,-1,0],[4987,1,1,0,0],[4036,2,-1,1,0],
    [3994,2,0,2,0],[3861,4,0,0,0],[3665,2,0,-3,0],[-2689,0,1,-2,0],
    [-2602,2,0,-1,2],[-2348,1,0,1,0],[2236,2,-2,0,0],[-2120,0,1,2,0],
  ];
  const rTerms=[
    [-20905355,0,0,1,0],[-3699111,2,0,-1,0],[-2955968,2,0,0,0],[-569925,0,0,2,0],
    [48888,0,1,0,0],[-3149,0,0,0,2],[246158,2,0,-2,0],[-152138,2,-1,-1,0],
    [-170733,2,0,1,0],[-204586,2,-1,0,0],[-129620,0,1,-1,0],[108743,1,0,0,0],
    [104755,0,1,1,0],[10321,2,0,0,-2],[0,0,0,1,2],[79661,0,0,1,-2],
    [-34782,4,0,-1,0],[-23210,0,0,3,0],[-21636,4,0,-2,0],[24208,2,1,-1,0],
    [30824,2,1,0,0],[-8379,1,0,-1,0],[-16675,1,1,0,0],[-12831,2,-1,1,0],
    [-10445,2,0,2,0],[-11650,4,0,0,0],[14403,2,0,-3,0],[-7003,0,1,-2,0],
    [0,2,0,-1,2],[10056,2,-1,-1,0],[6322,1,0,1,0],[-9884,2,-2,0,0],
  ];
  let sumL=0,sumB=0,sumR=0;
  for(let i=0;i<lTerms.length;i++){
    const [c,d,m,mp,f]=lTerms[i];
    const em=Math.abs(m)===1?E:(Math.abs(m)===2?E*E:1);
    const angle=d*D+m*M+mp*Mp+f*F;
    sumL+=c*em*Math.sin(angle);
    if(i<rTerms.length) sumR+=rTerms[i][0]*em*Math.cos(angle);
  }
  const bT=[
    [5128122,0,0,0,1],[280602,0,0,1,1],[277693,0,0,1,-1],[173237,2,0,0,-1],
    [55413,2,0,-1,1],[46271,2,0,-1,-1],[32573,2,0,0,1],[17198,0,0,2,1],
    [9266,2,0,1,-1],[8822,0,0,2,-1],[8216,2,-1,0,-1],[4324,2,0,-2,-1],
    [4200,2,0,1,1],[-3359,2,1,0,-1],[2463,2,-1,-1,1],[2211,2,-1,0,1],
  ];
  for(const [c,d,m,mp,f] of bT){
    const em=Math.abs(m)===1?E:(Math.abs(m)===2?E*E:1);
    sumB+=c*em*Math.sin(d*D+m*M+mp*Mp+f*F);
  }
  const lam=((218.3164477+481267.88123421*T-0.0015786*T*T)+sumL/1000000)%360;
  const bet=sumB/1000000;
  const eObl=23.439291111-(0.013004167+0.0000001639*T)*T;
  const lamR=lam*Math.PI/180,betR=bet*Math.PI/180,eR=eObl*Math.PI/180;
  const sinDec=Math.sin(betR)*Math.cos(eR)+Math.cos(betR)*Math.sin(eR)*Math.sin(lamR);
  const dec=Math.asin(sinDec);
  const ra=Math.atan2(Math.sin(lamR)*Math.cos(eR)-Math.tan(betR)*Math.sin(eR),Math.cos(lamR));
  const GMST=(280.46061837+360.98564736629*(toJD(date)-2451545)+(0.000387933-T/38710000)*T*T)%360;
  const H=((GMST+lng-ra*180/Math.PI)%360+360)%360;
  const Hr=H*Math.PI/180,latr=lat*Math.PI/180;
  const sinAlt=Math.sin(latr)*Math.sin(dec)+Math.cos(latr)*Math.cos(dec)*Math.cos(Hr);
  const altRaw=Math.asin(sinAlt)*180/Math.PI;
  const az=((Math.atan2(Math.sin(Hr),Math.cos(Hr)*Math.sin(latr)-Math.tan(dec)*Math.cos(latr))*180/Math.PI)+180)%360;
  const dist_km=385000.56+sumR/1000;
  const angDiam=2*Math.atan2(1737.4, dist_km)*180/Math.PI;
  const {dAz,dAlt}=calcParallax(H,dec*180/Math.PI,dist_km,lat);
  const altTopo=altRaw+dAlt;
  const alt=altTopo+refraction(altTopo);
  return{alt,az:((az+dAz)%360+360)%360,dist_km,angDiam,ra,dec,Hr};
}

// 太陽位置（Meeus Ch.25 ＋ 視差 ＋ 屈折）
export function sunPos(date,lat,lng){
  const JD=toJD(date);
  const T=(JD-2451545)/36525;
  const L0=(280.46646+36000.76983*T)%360;
  const M=(357.52911+35999.05029*T-0.0001537*T*T)*Math.PI/180;
  const C=(1.914602-0.004817*T-0.000014*T*T)*Math.sin(M)
         +(0.019993-0.000101*T)*Math.sin(2*M)+0.000289*Math.sin(3*M);
  const sunLon=(L0+C)*Math.PI/180;
  const e=23.439291111-(0.013004167+0.0000001639*T)*T;
  const eR=e*Math.PI/180;
  const sinL=Math.sin(sunLon),cosL=Math.cos(sunLon);
  const ra=Math.atan2(Math.cos(eR)*sinL,cosL);
  const dec=Math.asin(Math.sin(eR)*sinL);
  const GMST=(280.46061837+360.98564736629*(JD-2451545)+(0.000387933-T/38710000)*T*T)%360;
  const H=((GMST+lng-ra*180/Math.PI)%360+360)%360;
  const Hr=H*Math.PI/180,latr=lat*Math.PI/180;
  const sinAlt=Math.sin(latr)*Math.sin(dec)+Math.cos(latr)*Math.cos(dec)*Math.cos(Hr);
  const altRaw=Math.asin(sinAlt)*180/Math.PI;
  const az=((Math.atan2(Math.sin(Hr),Math.cos(Hr)*Math.sin(latr)-Math.tan(dec)*Math.cos(latr))*180/Math.PI)+180)%360;
  const ecc=0.016708634-0.000042037*T;
  const v=M+(C*Math.PI/180);
  const dist_au=(1.000001018*(1-ecc*ecc))/(1+ecc*Math.cos(v));
  const angDiam=2*Math.atan2(695700, dist_au*149597870)*180/Math.PI;
  const dist_km_sun=dist_au*149597870;
  const {dAz:dAz_sun,dAlt:dAlt_sun}=calcParallax(H,dec*180/Math.PI,dist_km_sun,lat);
  const altTopo=altRaw+dAlt_sun;
  const alt=altTopo+refraction(altTopo);
  return{alt,az:((az+dAz_sun)%360+360)%360,dist_au,angDiam,ra,dec,Hr};
}

// 月齢（真の朔からの経過日数：Meeus Ch.49）
function _trueNewMoonJDE(k){
  const T=k/1236.85, T2=T*T, T3=T*T2, T4=T*T3;
  let JDE=2451550.09766+29.530588861*k+0.00015437*T2-0.000000150*T3+0.00000000073*T4;
  const M=(2.5534+29.10535670*k-0.0000014*T2)*Math.PI/180;
  const Mp=(201.5643+385.81693528*k+0.0107582*T2)*Math.PI/180;
  const F=(160.7108+390.67050284*k-0.0016118*T2)*Math.PI/180;
  const Om=(124.7746-1.56375588*k+0.0020672*T2)*Math.PI/180;
  return JDE
    -0.40720*Math.sin(Mp)+0.17241*Math.sin(M)+0.01608*Math.sin(2*Mp)
    +0.01039*Math.sin(2*F)+0.00739*Math.sin(Mp-M)-0.00514*Math.sin(Mp+M)
    +0.00208*Math.sin(2*M)-0.00111*Math.sin(Mp-2*F)-0.00057*Math.sin(Mp+2*F)
    +0.00056*Math.sin(2*Mp+M)-0.00042*Math.sin(3*Mp)+0.00042*Math.sin(M+2*F)
    +0.00038*Math.sin(M-2*F)-0.00024*Math.sin(2*Mp-M)-0.00017*Math.sin(Om)
    -0.00007*Math.sin(Mp+2*M)+0.00004*Math.sin(2*Mp-2*F)+0.00004*Math.sin(3*M)
    +0.00003*Math.sin(Mp+M-2*F)+0.00003*Math.sin(2*Mp+2*F)
    -0.00003*Math.sin(Mp+M+2*F)+0.00003*Math.sin(Mp-M+2*F)
    -0.00002*Math.sin(Mp-M-2*F)-0.00002*Math.sin(3*Mp+M)+0.00002*Math.sin(4*Mp);
}
export function moonAge(date){
  const JD=date.valueOf()/86400000+2440587.5;
  const k0=Math.floor((JD-2451550.09766)/29.530588861);
  let bestJDE=null;
  for(let dk=-2;dk<=2;dk++){
    const jde=_trueNewMoonJDE(k0+dk);
    if(jde<=JD&&(bestJDE===null||jde>bestJDE)) bestJDE=jde;
  }
  return JD-bestJDE;
}

// 日の出・日の入り（sunPosを反復して求める）。サーバでは呼び出しごとにキャッシュ生成。
export function makeSunT(){
  const cache=new Map();
  return function sunT(date,lat,lng){
    const ds=date.toISOString().slice(0,10);
    const key=`${ds}_${lat.toFixed(4)}_${lng.toFixed(4)}`;
    if(cache.has(key))return cache.get(key);
    const base=new Date(ds+'T00:00:00+09:00');
    let rise=null,set=null,prev=null,prevT=null;
    // 用途は「日の出後30分／日没前30分」の窓判定のみ。秒精度は不要なので
    // 15分粗探索＋線形補間で近似（二分探索を廃止しCPU時間を大幅削減）。
    const thresh=-0.833;
    for(let h=0;h<=25.1;h+=15/60){
      const t=new Date(base.getTime()+h*3600000);
      const alt=sunPos(t,lat,lng).alt - refraction(sunPos(t,lat,lng).alt);
      if(prev!==null){
        if(prev<=thresh&&alt>thresh&&!rise){
          const frac=(thresh-prev)/(alt-prev);
          rise=new Date(prevT.getTime()+(t.getTime()-prevT.getTime())*frac);
        }
        if(prev>thresh&&alt<=thresh&&!set){
          const frac=(thresh-prev)/(alt-prev);
          set=new Date(prevT.getTime()+(t.getTime()-prevT.getTime())*frac);
        }
      }
      prev=alt;prevT=t;
    }
    const result=rise||set?{rise,set}:null;
    if(cache.size>=400){const fk=cache.keys().next().value;cache.delete(fk);}
    cache.set(key,result);
    return result;
  };
}

// 幾何・整形
export function brng(a,b,c,d){
  const r=Math.PI/180,dl=(d-b)*r;
  const y=Math.sin(dl)*Math.cos(c*r);
  const x=Math.cos(a*r)*Math.sin(c*r)-Math.sin(a*r)*Math.cos(c*r)*Math.cos(dl);
  return((Math.atan2(y,x)*180/Math.PI)+360)%360;
}
export function hav(a,b,c,d){
  const R=6371,r=Math.PI/180;
  const dA=(c-a)*r,dB=(d-b)*r;
  const x=Math.sin(dA/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin(dB/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
export function elAng(dKm,se,te,th){
  const R=6371000;
  const curv=(dKm*1000)**2/(2*R);
  const altRaw=Math.atan2((te+th)-(se+curv), dKm*1000)*180/Math.PI;
  const k=0.13, d=dKm*1000;
  const terrRefr=Math.atan2(k*d*d/(2*R), d)*180/Math.PI;
  return altRaw+terrRefr;
}
// クライアント jst() と同一：JSTのHH:MM（type="time"用）
export function jst(d){
  if(!d) return '—';
  return new Date(d.getTime()+9*3600000).toISOString().substr(11,5);
}
