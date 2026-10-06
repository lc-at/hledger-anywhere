-- | WASI/browser stub for "System.Console.Terminal.Size".
--
-- Every query reports that the terminal size is unknown, so hledger falls back
-- to its default report width instead of erroring. See terminal-size.cabal for
-- why this exists.
--
-- The types and signatures mirror the BSD-3-Clause @terminal-size@ package so
-- that hledger's imports typecheck unchanged.
module System.Console.Terminal.Size
    ( Window (..)
    , size
    , hSize
    , fdSize
    ) where

import System.IO (Handle)

-- | A terminal window's dimensions in character cells.
data Window a = Window
    { height :: !a
    , width :: !a
    }
    deriving (Eq, Show, Read)

-- | The size of the terminal on stdout, or 'Nothing' (always 'Nothing' here).
size :: Integral n => IO (Maybe (Window n))
size = return Nothing

-- | The size of the terminal attached to a handle, or 'Nothing' (always here).
hSize :: Integral n => Handle -> IO (Maybe (Window n))
hSize _ = return Nothing

-- | The size of the terminal on a file descriptor, or 'Nothing' (always here).
fdSize :: Integral n => Int -> IO (Maybe (Window n))
fdSize _ = return Nothing
