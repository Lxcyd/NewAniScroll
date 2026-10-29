# VM Oracle (phase 2 du plan infra)

Cloudflare -> Tunnel (`cloudflared`) -> nginx (cache disque) -> Next ; Redis
local derriere SRH (API REST d'Upstash). Aucun port ouvert : tout entre par le
Tunnel. Premiere mise en ligne sur `vm.aniscroll.com`, sans visiteurs ; la prod
ne bascule qu'en phase 4.

## 1. Compte Oracle (Luc)

- cloud.oracle.com -> Free Tier. **Home region = France Central (Paris)** : elle
  ne peut plus changer ensuite, et les ressources Always Free n'existent que la.
- Carte bancaire demandee pour verifier l'identite ; rien n'est debite tant que
  le compte reste en Free Tier (ne PAS passer en Pay As You Go).

## 2. La VM (Luc, ou Claude avec une cle API OCI)

- Compute -> Instances -> Create : image **Ubuntu 24.04 (aarch64)**, shape
  **VM.Standard.A1.Flex, 2 OCPU, 12 Go** (la moitie de l'allocation gratuite),
  disque 100 Go. Cle SSH : y coller la cle publique fournie par Claude.
- « Out of capacity » est frequent sur A1 : reessayer plus tard, ou changer
  d'Availability Domain.

## 3. Installation (Claude, en SSH)

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker ubuntu
git clone https://github.com/Lxcyd/NewAniScroll.git && cd NewAniScroll
cp /chemin/.env infra/vm/.env   # + TUNNEL_TOKEN, SRH_TOKEN (openssl rand -hex 32)
./infra/vm/deploy.sh dev
```

Dans `infra/vm/.env`, `NEXTAUTH_URL` = l'URL servie par la VM
(`https://vm.aniscroll.com` en phase 2).

## 4. Tunnel Cloudflare

Le jeton `CF_ZONE_API_TOKEN` doit avoir en plus **Account -> Cloudflare Tunnel
-> Edit**. Claude cree alors le tunnel, son `TUNNEL_TOKEN` et l'hote
`vm.aniscroll.com -> http://nginx:80`.

## Ce qui reste a faire avant la phase 4

- Crons (aujourd'hui GitHub Actions / Vercel) : a pointer sur la VM.
- Mesures : temps de reponse a froid / a chaud vs Vercel, lecteurs joignables
  depuis l'IP Oracle (certains bloquent les IP de cloud).
