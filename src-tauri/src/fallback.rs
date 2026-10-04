//! Offline fallback playlist.
//!
//! Only used when the upstream iptv-org file cannot be downloaded. These entries
//! were verified end to end (playlist -> ffmpeg -> H.264 transport stream) so a
//! first launch with no network still shows a working player instead of an
//! empty grid. The live playlist supersedes this as soon as it loads.

pub const FALLBACK_M3U: &str = r#"#EXTM3U
#EXTINF:-1 tvg-id="3ABNCanada.ca@SD" tvg-logo="https://i.imgur.com/U99CsEc.png" group-title="Religious",3ABN Canada (720p)
https://3abn.bozztv.com/3abncanada/3ABN/master.m3u8
#EXTINF:-1 tvg-id="3ABNEnglish.us@SD" tvg-logo="https://i.imgur.com/16DMxP4.png" group-title="Religious",3ABN English
https://3abn.bozztv.com/3abn2/3abn_live/smil:3abn_live.smil/playlist.m3u8
#EXTINF:-1 tvg-id="3ABNFrench.us@SD" tvg-logo="https://i.imgur.com/B5gsM7m.png" group-title="Religious",3ABN French
https://3abn.bozztv.com/3abn2/Fre_live/smil:Fre_live.smil/playlist.m3u8
#EXTINF:-1 tvg-id="3ABNKids.us@SD" tvg-logo="https://i.imgur.com/z3npqO1.png" group-title="Animation;Kids;Religious",3ABN Kids
https://3abn.bozztv.com/3abn2/Kids_live/smil:Kids_live.smil/playlist.m3u8
#EXTINF:-1 tvg-id="3ABNLatino.us@SD" tvg-logo="https://i.imgur.com/Ugb4AFo.png" group-title="Religious",3ABN Latino
https://3abn.bozztv.com/3abn2/Lat_live/smil:Lat_live.smil/playlist.m3u8
#EXTINF:-1 tvg-id="3ABNPraiseHimMusicNetwork.us@SD" tvg-logo="https://i.imgur.com/iBcqT8L.png" group-title="Music;Religious",3ABN Music Network
https://3abn.bozztv.com/3abn1/PraiseHim/smil:PraiseHim.smil/playlist.m3u8
#EXTINF:-1 tvg-id="3ABNTVUganda.ug@SD" tvg-logo="https://i.imgur.com/mml9lI2.png" group-title="Religious",3ABN TV Uganda
https://3abn.bozztv.com/3abn/3abn_uganda_live/index.m3u8
#EXTINF:-1 tvg-id="3CatPlatsbruts.es@SD" tvg-logo="https://i.imgur.com/49ZENis.png" group-title="Classic;Comedy;Public;Series",3Cat Plats bruts (1080p)
https://fast-tailor.3catdirectes.cat/v1/channel/ccma-channel2/hls.m3u8
#EXTINF:-1 tvg-id="3CatExclusiu2.es@SD" tvg-logo="https://i.imgur.com/YQvLPT1.png" group-title="News;Public",3Cat Exclusiu 2 (1080p)
https://directes-tv-cat.3catdirectes.cat/live-content/oca2-hls/master.m3u8
#EXTINF:-1 tvg-id="3CatCameresdeltemps.es@SD" tvg-logo="https://i.imgur.com/zXy2kbe.png" group-title="Public;Weather",3Cat Cameres del temps (1080p)
https://directes-tv-int.3catdirectes.cat/live-content/beauties-hls/master.m3u8
#EXTINF:-1 tvg-id="123tv.de@SD" tvg-logo="https://i.imgur.com/slSUDNX.png" group-title="Shop",1-2-3.tv (270p)
https://123tv-mx1.flex-cdn.net/index.m3u8
#EXTINF:-1 tvg-id="3HD.th@SD" tvg-logo="https://i.imgur.com/YRiulCU.png" group-title="General",3HD
https://live-us1.thaimomo.com/live-as/ch3hd-3/playlist.m3u8
#EXTINF:-1 tvg-id="2Plus2Marathon.ua@SD" tvg-logo="https://i.imgur.com/v6KBgqk.png" group-title="General",2+2 Marathon (1080p)
https://lowa8026-cmyk.github.io/Ukraine/Edyni_Novyny/2Plus2Marafon.m3u8
#EXTINF:-1 tvg-id="1Plus1Marafon.ua@SD" tvg-logo="https://i.imgur.com/smQKa2G.png" group-title="General",1+1 Marafon (1080p)
https://dash2.antik.sk/live/1plus1_marathon/playlist.m3u8
#EXTINF:-1 tvg-id="1KZNTV.za@SD" tvg-logo="https://admango.cdn.mangomolo.com/analytics/uploads/188/6544bebaae.jpg" group-title="Entertainment;Family;General",1KZN TV (576p)
https://cdn.freevisiontv.co.za/sttv/smil:1kzn.stream.smil/playlist.m3u8
#EXTINF:-1 tvg-id="1AlmereTV.nl@SD" tvg-logo="https://i.imgur.com/XfkbTrU.png" group-title="General",1AlmereTV (720p)
https://d3472rjicrodic.cloudfront.net/nlpo/clr-nlpo/709d5260/index.m3u8
"#;