import type { BoardExtraction } from '../domain/board.ts'

/**
 * **The Long Pier, extracted by hand** — what the model would return for
 * `fixtures/greyharbor/episode/01-the-long-pier/script.md`, written out so that E3-1's rules
 * can be proved without a model, a network call, or a cent (fixtures before features).
 *
 * ## The script is the fixed point, and this file conforms to it
 *
 * Every row below was read out of the script as it stands, and NOT ONE LINE OF THE SCRIPT
 * MAY BE EDITED TO MAKE A ROW EASIER. The two defects in it are planted (`episode.md`,
 * "What is planted here"), the near-misses around them are planted just as deliberately, and
 * a script bent to suit an extraction would prove that the rules can read a script written
 * for them. Check every value here against `script.md` before changing it; if they disagree,
 * this file is wrong.
 *
 * ## What is in it, scene by scene
 *
 * - **1 · Mess deck, 06:10.** Ilse and Tobin, inside. Tobin "comes in sideways" — the first
 *   of the script's three narrated entrances.
 * - **2 · Harbourmaster's office, 06:40.** Both, inside. Neither entrance is narrated, so
 *   neither arrives: `arrives` is what the SCRIPT SHOWS, not what the grid implies. Derived
 *   from the grid it would be worthless — a character whose last row was elsewhere has
 *   obviously arrived, and a rule over that could never fire.
 * - **3 · No. 4 lock, 07:05.** Tobin, inside, in coveralls. Four Kestrel collars stay on
 *   their pegs behind him.
 * - **4 · The Long Pier, 07:07.** Tobin, **exposed**, **protection `none`** — three minutes
 *   outside the pressure hull in coveralls. This is the planted world-rules violation, and
 *   the vacuum rule catches it deterministically because the Halvani hazard below is in his
 *   scope through the `species` edge (D22). E3-2's semantic check owns the same scene from
 *   the other side; both firing is 4.5's clustering, not a duplicate.
 * - **5 · Harbourmaster's office, 07:20.** Ilse and Tobin, inside. Tobin arrives.
 * - **6 · The Long Pier, CONTINUOUS.** Ilse, exposed, **hardsuit**. CONTINUOUS is resolved
 *   to scene 5's clock here, in extraction, where the reading happens — a rule compares
 *   numbers and never parses a heading.
 *
 * Scenes 5 and 6 are the planted continuity contradiction: one woman, two places, one clock.
 * Scene 6 is the only CONTINUOUS in the script and that is deliberate — every other scene
 * carries its own time, so the board has no innocent shared clock to confuse it with.
 *
 * ## What is deliberately absent
 *
 * There is no transit between the mess deck, the office and the lock, because canon states
 * none: `grey-harbor-station.md` gives a number for cycling the No. 4 lock and for nothing
 * else. So the adjacency rule ABSTAINS on those crossings rather than guessing at them, and
 * the fixture proves the abstention as well as the comparison.
 */
export function theLongPierExtraction(facts: LongPierFacts): BoardExtraction {
  return {
    scenes: [
      {
        scene: 1,
        location: 'Mess deck',
        locationEntity: 'Grey Harbor Station',
        environment: 'inside',
        elapsed: '06:10',
        elapsedSeconds: clock('06:10'),
        present: [
          { character: 'Ilse Renn', entity: 'Ilse Renn', protection: 'none' },
          { character: 'Tobin Wick', entity: 'Tobin Wick', protection: 'none', arrives: true },
        ],
      },
      {
        scene: 2,
        location: "Harbourmaster's office",
        locationEntity: 'Grey Harbor Station',
        environment: 'inside',
        elapsed: '06:40',
        elapsedSeconds: clock('06:40'),
        present: [
          { character: 'Ilse Renn', entity: 'Ilse Renn', protection: 'none' },
          { character: 'Tobin Wick', entity: 'Tobin Wick', protection: 'none' },
        ],
      },
      {
        scene: 3,
        location: 'No. 4 lock',
        locationEntity: 'Grey Harbor Station',
        environment: 'inside',
        elapsed: '07:05',
        elapsedSeconds: clock('07:05'),
        present: [{ character: 'Tobin Wick', entity: 'Tobin Wick', protection: 'none' }],
      },
      {
        scene: 4,
        location: 'The Long Pier',
        locationEntity: 'Grey Harbor Station',
        environment: 'exposed',
        elapsed: '07:07',
        elapsedSeconds: clock('07:07'),
        present: [
          { character: 'Tobin Wick', entity: 'Tobin Wick', protection: 'none', arrives: true },
        ],
      },
      {
        scene: 5,
        location: "Harbourmaster's office",
        locationEntity: 'Grey Harbor Station',
        environment: 'inside',
        elapsed: '07:20',
        elapsedSeconds: clock('07:20'),
        present: [
          { character: 'Ilse Renn', entity: 'Ilse Renn', protection: 'none' },
          { character: 'Tobin Wick', entity: 'Tobin Wick', protection: 'none', arrives: true },
        ],
      },
      {
        scene: 6,
        location: 'The Long Pier',
        locationEntity: 'Grey Harbor Station',
        environment: 'exposed',
        elapsed: 'CONTINUOUS',
        elapsedSeconds: clock('07:20'),
        present: [{ character: 'Ilse Renn', entity: 'Ilse Renn', protection: 'hardsuit' }],
      },
    ],

    // "Cycling the No. 4 lock takes ninety seconds in either direction, and it cannot be
    // cycled with both doors open", and "the No. 4 lock is the only route between the inboard
    // decks and the Long Pier" — so ninety seconds is the floor on any inboard↔pier crossing,
    // which is what the rule compares a gap against.
    transits: [
      {
        from: 'No. 4 lock',
        to: 'The Long Pier',
        seconds: 90,
        fact: facts.lockCycle,
        eitherWay: true,
      },
      {
        from: "Harbourmaster's office",
        to: 'The Long Pier',
        seconds: 90,
        fact: facts.lockCycle,
        eitherWay: true,
      },
    ],

    // D22, made checkable: the rule about vacuum catches nobody until something in scope says
    // what a body is. This names the fact and states nothing itself.
    hazards: [
      { entity: 'Halvani', hazard: 'lethal-in-vacuum', fact: facts.halvaniVacuum },
    ],
  }
}

/** The two canon facts the extraction cites, by id, as the real step's prompt supplies them. */
export interface LongPierFacts {
  /** Grey Harbor Station · "Cycling the No. 4 lock takes ninety seconds in either direction". */
  lockCycle: string
  /** Halvani · "…loses consciousness in about nine seconds and dies inside two minutes". */
  halvaniVacuum: string
}

/** A scene heading's clock as seconds since midnight — the reading, done where reading belongs. */
function clock(at: string): number {
  const [hours, minutes] = at.split(':').map(Number)
  return hours! * 3600 + minutes! * 60
}
