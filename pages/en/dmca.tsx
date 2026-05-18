import Footer from "@/components/shared/footer";
import { Navbar } from "@/components/shared/NavBar";
import MobileNav from "@/components/shared/MobileNav";
import Head from "next/head";

export default function DMCA() {
  return (
    <>
      <Head>
        <title>AniScroll • Beta</title>
        <meta
          name="description"
          content="AniScroll's disclaimer, DMCA process, and a note on the project's status."
        />
        <meta property="og:title" content="DMCA · AniScroll" />
        <meta
          property="og:description"
          content="AniScroll respects copyright. Read our DMCA process and project status."
        />
        <meta property="og:image" content="/logo.png" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>

      <Navbar withNav scrollP={5} shrink />
      <MobileNav hideProfile />

      <main className="min-h-screen w-full pt-[80px] pb-20">
        <div className="mx-auto w-[90%] lg:w-[70%] max-w-3xl flex flex-col gap-10">
          {/* Hero */}
          <header className="flex flex-col gap-2">
            <h1 className="font-outfit font-bold text-4xl lg:text-5xl text-white">
              DMCA &amp; Disclaimer
            </h1>
            <p className="font-karla text-white/60">
              Read this before sending a takedown notice — it saves both of us time.
            </p>
          </header>

          {/* Project status (the personal note) */}
          <section className="bg-secondary rounded-card p-6 ring-1 ring-white/5">
            <h2 className="font-outfit font-semibold text-action text-2xl mb-3">
              A note on this project
            </h2>
            <div className="font-karla text-white/85 space-y-3 leading-relaxed">
              <p>
                AniScroll is a personal side project I build because I love anime
                and I wanted a player that felt right. It is not a business —
                there are no ads, and there never will be.
              </p>
              <p>
                Right now the site is actively maintained and getting regular
                updates — see the changelog in the navbar for what landed
                recently. That said, I can&apos;t promise it will always be
                the case. Real life, time, and motivation all have a vote.
                If updates ever slow down or stop, that&apos;s why.
              </p>
              <p className="text-white/60 text-sm">
                Thanks for using the site. If you find a bug, use the Report
                button in the navbar and I&apos;ll get the message.
              </p>
            </div>
          </section>

          {/* Disclaimer */}
          <section>
            <h2 className="font-outfit font-semibold text-2xl text-white mb-3">
              Disclaimer
            </h2>
            <div className="font-karla text-white/80 space-y-3 leading-relaxed">
              <p>
                AniScroll does <strong>not</strong> host any video, audio, or
                manga files. Every stream you watch and every page you read is
                served from a third-party source — we only link to them, the
                same way a search engine links to a webpage.
              </p>
              <p>
                We do not control those third-party hosts, their availability,
                their content moderation, or how long any given link will keep
                working. If a link is broken or returns problematic content,
                report it via the in-app form and we&apos;ll remove the
                association from our index.
              </p>
            </div>
          </section>

          {/* DMCA process */}
          <section>
            <h2 className="font-outfit font-semibold text-2xl text-white mb-3">
              DMCA takedown process
            </h2>
            <div className="font-karla text-white/80 space-y-3 leading-relaxed">
              <p>
                We comply with the Digital Millennium Copyright Act (DMCA). If
                you are a rights holder and you believe content indexed on
                AniScroll infringes your rights, send an email with the
                information listed below. Allow 2 – 5 business days for a
                response.
              </p>
              <p className="text-white/60 text-sm">
                Note: contacting our hosting / DNS / CDN providers will not
                speed things up and may delay the takedown by routing your
                request through the wrong queue.
              </p>
            </div>

            <div className="mt-4 bg-as-card rounded-card p-5 ring-1 ring-white/5">
              <p className="font-karla text-white font-semibold mb-2">
                Please include:
              </p>
              <ul className="font-karla text-white/80 space-y-1.5 list-disc pl-5">
                <li>Your name, postal address, and a working phone number.</li>
                <li>
                  Identification of the copyrighted work you claim has been
                  infringed.
                </li>
                <li>
                  The complete URL(s) on AniScroll where the infringing
                  material is referenced.
                </li>
                <li>
                  A statement that you have a good-faith belief the use is not
                  authorised, and that the information you provide is accurate.
                </li>
                <li>
                  A physical or electronic signature of the rights holder or
                  authorised representative.
                </li>
              </ul>
            </div>

            <p className="mt-4 font-karla text-white/80">
              An email address for DMCA notices is{" "}
              <span className="text-white/60 italic">
                not available yet
              </span>
              . In the meantime, please use the Report button in the navbar
              with as much detail as you would put in an email and I&apos;ll
              follow up.
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </>
  );
}
