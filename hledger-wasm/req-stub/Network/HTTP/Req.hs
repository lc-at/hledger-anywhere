-- | WASI/browser stub for "Network.HTTP.Req".
--
-- There is no network in a browser build, so 'req' throws as soon as the
-- request is run. hledger's @setup@ command is the only caller and already
-- catches everything, reporting "unknown" instead of failing.
--
-- The types and signatures mirror the BSD-3-Clause @req@ package so that
-- @Hledger.Cli.Commands.Setup@ typechecks unchanged. See req.cabal for why this
-- exists and why stubbing @req@ (rather than patching @basement@) is the route
-- we take.
module Network.HTTP.Req
    ( req
    , runReq
    , defaultHttpConfig
    , HttpConfig (..)
    , Req
    -- Each of these is used by hledger as a *term* (`req HEAD url ...`), so the
    -- constructor has to be exported, not just the type. Exporting the bare name
    -- exports the type only, which fails with "Illegal term-level use of the
    -- type constructor".
    , GET (..)
    , HEAD (..)
    , http
    , https
    , (/:)
    , Url
    , Option
    , responseTimeout
    , NoReqBody (..)
    , bsResponse
    , BsResponse
    , responseBody
    , HttpException (..)
    ) where

import Control.Exception (Exception, throwIO)
import Control.Monad.IO.Class (MonadIO (..))
import Data.ByteString (ByteString)
import Data.Proxy (Proxy (..))
import Data.Text (Text)
import qualified Data.Text as T
import qualified Network.HTTP.Client as C

-- | A URL under construction.
newtype Url = Url { unUrl :: Text }

-- | Start an @http://@ URL.
http :: Text -> Url
http = Url

-- | Start an @https://@ URL.
https :: Text -> Url
https = Url

-- | Append a path segment.
--
-- Written with 'T.singleton' rather than a @"/"@ literal so this module needs no
-- language extension: without @OverloadedStrings@ a bare literal would be a
-- @String@, which does not concatenate with the @Text@ it is spliced into.
(/:) :: Url -> Text -> Url
Url base /: segment = Url (base <> T.singleton '/' <> segment)

-- | The HTTP methods hledger uses.
data GET = GET
data HEAD = HEAD

-- | A request with no body.
data NoReqBody = NoReqBody

-- | A request option. Only the timeout is constructed, and it is ignored.
data Option = Option

-- | Ignore a request timeout.
responseTimeout :: Int -> Option
responseTimeout _ = Option

-- | A response whose body is a strict 'ByteString'.
newtype BsResponse = BsResponse ByteString

-- | A 'Proxy' selecting 'BsResponse'.
bsResponse :: Proxy BsResponse
bsResponse = Proxy

-- | The body of a 'BsResponse'.
responseBody :: BsResponse -> ByteString
responseBody (BsResponse body) = body

-- | The part of the real @HttpConfig@ that hledger names.
data HttpConfig = HttpConfig
    { httpConfigRedirectCount :: Int
    }

-- | The part of the real @defaultHttpConfig@ that hledger needs.
defaultHttpConfig :: HttpConfig
defaultHttpConfig = HttpConfig {httpConfigRedirectCount = 10}

-- | A request description. It carries nothing, because it can only fail.
newtype Req a = Req {runRequest :: HttpConfig -> IO a}

instance Functor Req where
    fmap f (Req action) = Req (fmap f . action)

instance Applicative Req where
    pure value = Req (\_ -> pure value)
    Req f <*> Req x = Req (\config -> f config <*> x config)

instance Monad Req where
    Req action >>= f =
        Req (\config -> action config >>= \value -> runRequest (f value) config)

instance MonadIO Req where
    liftIO io = Req (\_ -> io)

-- | Run a request. Always fails; see 'req'.
runReq :: MonadIO m => HttpConfig -> Req a -> m a
runReq config (Req action) = liftIO (action config)

-- | Build a request. It throws when run, because there is no network.
--
-- The throw is a 'JsonHttpException', which is one of the constructors hledger
-- already matches on. That matters: it means the @http-client@ constructors it
-- also matches ('VanillaHttpException' wrapping a 'StatusCodeException') are
-- never reached, so the stubbed @http-client@ accessors below are dead code that
-- can never be forced.
req :: method -> Url -> body -> Proxy response -> Option -> Req response
req _ _ _ _ _ =
    Req
        ( \_ ->
            throwIO (JsonHttpException "the network is unavailable in a wasm build")
        )

-- | The exception type of the real @req@: its own constructors, one of which
-- wraps @http-client@'s exception.
data HttpException
    = VanillaHttpException C.HttpException
    | JsonHttpException String
    deriving (Show)

instance Exception HttpException
